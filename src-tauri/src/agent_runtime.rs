//! In-process EchoAgent runtime bridge.
//!
//! The agent (`MvpAgent` from `xai-grok-shell`) is `!Send` (all fields are
//! `Rc`/`RefCell`), so it must live on one OS thread driven by a
//! current-thread tokio runtime + `LocalSet`. We spawn that thread once at
//! app startup and communicate with the agent purely through the typed ACP
//! mpsc channels from `xai-acp-lib::acp_channels()`.
//!
//! Pattern A (direct dispatch) from `xai-grok-pager/src/acp/spawn.rs`: the
//! gateway receiver calls `MvpAgent`'s `acp::Agent` methods directly over
//! `Rc<MvpAgent>` — no byte streams, no line framing, no WebSocket.
//!
//! `ClientCapabilities` advertise NO fs/terminal support, so the agent uses
//! its own built-in tool implementations (read_file, run_terminal_command,
//! etc.) rather than round-tripping them back to us. We only need to handle
//! `session/update` (streaming + tool calls) and `session/request_permission`.

use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;

use agent_client_protocol as acp;
use anyhow::{anyhow, Result};
use base64::Engine;
use serde::Serialize;
use tokio_util::sync::CancellationToken;

use xai_acp_lib::{
    acp_channels, acp_send, AcpAgentGatewaySender, AcpAgentTx, AcpClientRx, AcpGatewayReceiver,
};
use xai_grok_shell::agent::init::bootstrap;
use xai_grok_shell::agent::mvp_agent::MvpAgent;
use xai_grok_shell::auth::{AuthManager, GrokComConfig};
use xai_grok_shell::util::config::load_effective_config;

// Re-aliased to mirror EchoAgent's own internal import style.
use xai_grok_shell::agent::config::{Config as AgentConfig, RuntimeResolutionContext};

/// One end of the ACP channel pair that lives on the Tauri (multi-thread) side.
/// The client sends requests to the agent via `tx` (`AcpAgentTx`) and receives
/// responses/notifications from the agent via `rx` (`AcpClientRx`). The agent
/// thread holds the other end.
pub struct AgentHandle {
    pub tx: AcpAgentTx,
    pub rx: AcpClientRx,
    pub cancel: CancellationToken,
    /// JoinHandle for the agent OS thread. Used to detect unexpected exits
    /// (panics, crashes) so the frontend can show a "restart agent" prompt.
    pub thread: Option<std::thread::JoinHandle<Result<()>>>,
}

/// Spawn the EchoAgent runtime in-process on a dedicated thread.
///
/// `cwd` is the working directory the agent binds sessions to (typically the
/// user's home or a chosen project). Model credentials come exclusively from
/// provider configuration; the upstream auth adapter is intentionally empty.
///
/// EchoAgent intentionally skips the upstream startup remote-settings/models
/// prefetch (the synchronous `start_early_prefetch` join inside `bootstrap`).
/// That call hits upstream remote backends and can block first launch for tens of seconds
/// on slow networks; BYOK users only need local `config.toml` models. We seed
/// an empty `RemoteSettings` so bootstrap treats remote config as already
/// supplied and never opens the network path.
pub fn spawn_agent_runtime(_cwd: PathBuf) -> Result<AgentHandle> {
    // Team tools 已迁移到内嵌 MCP server（team_mcp.rs，lib.rs 启动时 serve）。
    // 这里不再需要注册 —— new_session 会把 MCP server 传给 EchoAgent，EchoAgent 以
    // client 身份连接（工具名 echoagent__create_team 等）。对 EchoAgent 零补丁。

    // 1. Load + resolve config (~/.echo-agent/config.toml; defaults if absent).
    let raw = load_effective_config().map_err(|e| anyhow!("load config: {e}"))?;
    let mut cfg = AgentConfig::new_from_toml_cfg(&raw).map_err(|e| anyhow!("parse config: {e}"))?;
    // The embedded Runtime ships memory as an opt-in feature. EchoAgent is a
    // local Agent workspace, so memory is a first-class feature and defaults
    // on unless the user explicitly disables `[memory].enabled`.
    // `raw` is the embedded Runtime's toml 0.9 value while the desktop
    // settings module intentionally uses its direct toml 0.8 dependency.
    // Read this host override in-place instead of crossing those crate types.
    let memory_enabled = raw
        .get("memory")
        .and_then(|memory| memory.get("enabled"))
        .and_then(|enabled| enabled.as_bool())
        .unwrap_or(true);
    // Empty remote settings: local defaults only. Must be set both here (runtime
    // resolution) and on `cfg.remote_settings` before bootstrap (see below).
    let local_remote_settings = xai_grok_shell::util::config::RemoteSettings::default();
    cfg.resolve_runtime_fields(&RuntimeResolutionContext {
        raw_config: &raw,
        remote_settings: Some(&local_remote_settings),
        is_headless: true,
        cli_subagents: Some(false),
        cli_web_search_model: None,
        cli_session_summary_model: None,
        memory_enabled_override: Some(memory_enabled),
        disable_web_search: false,
        todo_gate: false,
        laziness_debug_log: None,
        storage_mode: None,
    });

    // Skip bootstrap's shell-level remote_settings fallback fetch
    // (`start_early_prefetch` + thread join). See module comment above.
    cfg.remote_settings = Some(local_remote_settings);

    // BYOK model isolation: if the user has any [model.*] with a custom
    // base_url, set endpoints.models_base_url so the runtime's `has_custom_endpoint()`
    // returns true → skips loading built-in default models (gpt-5.6-terra,
    // Claude, Kimi, etc.). Those built-ins route through an upstream proxy that
    // requires upstream credentials, so selecting one in a BYOK-only setup yields 401.
    if cfg.endpoints.models_base_url.is_none() {
        if let Some(first_byok_url) = cfg
            .config_models
            .values()
            .filter_map(|m| m.base_url.as_deref())
            .find(|u| !u.is_empty())
        {
            cfg.endpoints.models_base_url = Some(first_byok_url.to_string());
            tracing::info!(
                models_base_url = %first_byok_url,
                "BYOK: set endpoints.models_base_url to skip built-in default models"
            );
        }
    }

    // 2. The upstream agent constructor requires an AuthManager even for
    // provider-configured models. Isolate it from legacy auth.json and disable
    // inline/alternate upstream credentials so it remains an inert adapter.
    let provider_runtime_home = crate::paths::echo_agent_home_dir().join(".provider-runtime");
    let auth_manager = Arc::new(AuthManager::new(
        &provider_runtime_home,
        GrokComConfig::default(),
    ));

    // 3. Bootstrap: telemetry, bundled files, ModelsManager.
    // Network catalog prefetch is skipped because remote_settings is already Some.
    let (cfg, models_manager) =
        bootstrap(&cfg, &auth_manager, None).map_err(|e| anyhow!("bootstrap: {e}"))?;

    // 4. Typed ACP channel pair.
    let (acp_client, acp_agent) = acp_channels();
    let cancel = CancellationToken::new();

    // 5. Agent thread (!Send → own OS thread + current_thread runtime + LocalSet).
    let cancel_for_thread = cancel.clone();
    let thread_handle = std::thread::Builder::new()
        .name("echo-agent-runtime".into())
        .spawn(move || -> Result<()> {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            let local = tokio::task::LocalSet::new();
            local.block_on(&rt, async move {
                let client_tx = acp_agent.tx.clone();
                // The gateway sender implements `acp::Client` and forwards the
                // agent's reverse-direction calls onto our mpsc channel.
                // `AcpAgentGatewaySender` = `AcpGatewaySender<acp::AgentSide>`,
                // whose OutMessage is `AcpClientMessage` — matching what
                // `acp_agent.tx` (Sender<AcpClientMessage>) accepts.
                let gateway = AcpAgentGatewaySender::new(client_tx);
                let agent = MvpAgent::with_models(gateway, &cfg, auth_manager, models_manager);
                let agent_rc = Rc::new(agent);

                // Direct dispatch: the receiver calls MvpAgent's `acp::Agent`
                // methods directly (Pattern A from spawn_grok_shell). Use the
                // generic AcpGatewayReceiver (not the AcpAgentGatewayReceiver
                // alias, which fixes C = AgentSideConnection).
                let gw_rx = AcpGatewayReceiver::new(acp_agent.rx, agent_rc).with_tracing(true);
                tokio::task::spawn_local(gw_rx.run());
                tokio::task::yield_now().await;

                cancel_for_thread.cancelled().await;
                Ok(())
            })
        })?;

    Ok(AgentHandle {
        tx: acp_client.tx,
        rx: acp_client.rx,
        cancel,
        thread: Some(thread_handle),
    })
}

// ---------- ACP lifecycle helpers ----------

/// Outcome of `initialize`. Provider authentication is configured separately.
#[derive(Debug, Serialize, Clone)]
pub struct InitOutcome {
    pub ok: bool,
    pub default_model_id: Option<String>,
    pub agent_version: Option<String>,
}

/// Run `initialize` against the agent. Advertises NO fs/terminal capability
/// so the agent runs its own tools.
pub async fn initialize(tx: &AcpAgentTx) -> Result<InitOutcome> {
    let meta = serde_json::json!({
        "clientType": "echoagent",
        "clientVersion": env!("CARGO_PKG_VERSION"),
    });
    let req = acp::InitializeRequest::new(acp::ProtocolVersion::V1)
        .client_capabilities(
            // Advertise NO fs and NO terminal capability → the agent uses its
            // own built-in file/shell tools and never round-trips those
            // requests back to us. (ClientCapabilities::new() defaults to
            // both disabled; we only spell out terminal(false) for clarity.)
            acp::ClientCapabilities::new().terminal(false),
        )
        .meta(meta.as_object().cloned());
    let resp: acp::InitializeResponse = acp_send(req, tx)
        .await
        .map_err(|e| anyhow!("initialize: {e:?}"))?;

    Ok(InitOutcome {
        ok: true,
        // EchoAgent's modelState uses `currentModelId` (not `defaultModelId`) for
        // the active model. Try both keys defensively in case of version skew.
        default_model_id: resp
            .meta
            .as_ref()
            .and_then(|m| m.get("modelState"))
            .and_then(|v| v.get("currentModelId").or_else(|| v.get("defaultModelId")))
            .and_then(|v| v.as_str())
            .map(String::from),
        agent_version: resp
            .meta
            .as_ref()
            .and_then(|m| m.get("agentVersion"))
            .and_then(|v| v.as_str())
            .map(String::from),
    })
}

/// Create a new session bound to `cwd`. Returns the new session id.
///
/// If `model_id` is supplied, it is passed as `_meta.modelId` so EchoAgent binds
/// the session to that model from the very start. This avoids the
/// new_session → set_session_model two-step, which could leave the session's
/// sampling config pinned to EchoAgent's default model (`grok-build`, which has
/// no key in a BYOK-only setup) before the switch lands.
///
/// The in-process team MCP server (team_mcp.rs) rides along as a client-side
/// `mcp_servers` entry — EchoAgent's merge gives the client layer top priority,
/// so the team tools (`echoagent__create_team` etc.) are live from this
/// session's first turn. Persistent registration to config.toml happens
/// separately after the session exists (team_mcp::persist_registration).
pub async fn new_session(tx: &AcpAgentTx, cwd: &Path, model_id: Option<&str>) -> Result<String> {
    new_session_with_options(tx, cwd, model_id, None).await
}

/// Create a session with optional per-session reasoning effort. Automations
/// persist the legacy `modelIsThinking` switch; mapping it to `high` makes that
/// switch affect the actual runtime instead of being dead metadata.
pub async fn new_session_with_options(
    tx: &AcpAgentTx,
    cwd: &Path,
    model_id: Option<&str>,
    reasoning_effort: Option<&str>,
) -> Result<String> {
    tracing::info!(cwd = %cwd.display(), model_id, "echoagent: new_session send");
    let mut servers = Vec::new();
    if let Some(url) = crate::team_mcp::server_url() {
        servers.push(acp::McpServer::Http(acp::McpServerHttp::new(
            crate::team_mcp::MCP_SERVER_NAME,
            url,
        )));
    }
    if let Some((url, token)) = crate::org_mcp::server_config() {
        servers.push(acp::McpServer::Http(
            acp::McpServerHttp::new(crate::org_mcp::MCP_SERVER_NAME, url).headers(vec![
                acp::HttpHeader::new(crate::org_mcp::AUTH_HEADER, token),
            ]),
        ));
    }
    let mut req = acp::NewSessionRequest::new(cwd.to_path_buf()).mcp_servers(servers);
    let mut meta = serde_json::Map::new();
    if let Some(mid) = model_id.filter(|s| !s.is_empty()) {
        meta.insert("modelId".into(), serde_json::Value::String(mid.into()));
    }
    if let Some(effort) = reasoning_effort.filter(|s| !s.is_empty()) {
        meta.insert(
            "reasoningEffort".into(),
            serde_json::Value::String(effort.into()),
        );
    }
    if !meta.is_empty() {
        req = req.meta(Some(meta));
    }
    let resp: acp::NewSessionResponse = acp_send(req, tx).await.map_err(|e| {
        tracing::error!(error = ?e, "echoagent: new_session FAILED");
        anyhow!("new_session: {e:?}")
    })?;
    tracing::info!(session_id = %resp.session_id.0, "echoagent: new_session OK");
    Ok(resp.session_id.0.to_string())
}

/// Resume an existing session by replaying its persisted history.
pub async fn load_session(tx: &AcpAgentTx, session_id: &str, cwd: &Path) -> Result<()> {
    let req = acp::LoadSessionRequest::new(
        acp::SessionId::new(session_id.to_string()),
        cwd.to_path_buf(),
    );
    let _: acp::LoadSessionResponse = acp_send(req, tx)
        .await
        .map_err(|e| anyhow!("load_session: {e:?}"))?;
    Ok(())
}

/// Send a user prompt. ACP resolves this request after the complete model turn;
/// streamed updates arrive earlier on the client rx channel (drained by the
/// dispatcher in bridge.rs).
///
/// Automatically retries on 429 rate-limit errors with an exponential backoff
/// (30s → 60s, max 2 retries) so transient TPM/RPM limits don't immediately
/// surface as hard errors.
pub async fn prompt(tx: &AcpAgentTx, session_id: &str, text: &str) -> Result<()> {
    prompt_with_attachments(tx, session_id, text, &[], None).await
}

fn image_mime(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// Build a typed ACP prompt. `displayText` and the original attachment paths
/// live in content metadata so history replay can restore the exact user-facing
/// bubble without exposing injected project/expert context.
fn build_prompt_blocks(
    text: &str,
    attachments: &[String],
    display_text: Option<&str>,
) -> Result<Vec<acp::ContentBlock>> {
    let mut referenced = Vec::new();
    let mut images = Vec::new();
    for raw in attachments {
        let path = PathBuf::from(raw);
        if let Some(mime) = image_mime(&path) {
            let metadata = std::fs::metadata(&path)
                .map_err(|e| anyhow!("attachment {}: {e}", path.display()))?;
            if metadata.len() > 20 * 1024 * 1024 {
                return Err(anyhow!("image attachment exceeds 20MB: {}", path.display()));
            }
            let bytes = std::fs::read(&path)
                .map_err(|e| anyhow!("read attachment {}: {e}", path.display()))?;
            let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
            images.push(acp::ContentBlock::Image(
                acp::ImageContent::new(encoded, mime).uri(Some(raw.clone())),
            ));
        }
        referenced.push(format!("- @{raw}"));
    }
    let prompt_text = if referenced.is_empty() {
        text.to_string()
    } else {
        format!(
            "{text}\n\n附件（图片已作为多模态内容附加；其他文件请使用 read_file 读取）：\n{}",
            referenced.join("\n")
        )
    };
    let mut text_meta = acp::Meta::new();
    text_meta.insert(
        "displayText".into(),
        serde_json::Value::String(display_text.unwrap_or(text).to_string()),
    );
    if !attachments.is_empty() {
        text_meta.insert(
            "echoAgentAttachments".into(),
            serde_json::json!(attachments),
        );
    }
    let text_block = acp::ContentBlock::Text(acp::TextContent::new(prompt_text).meta(text_meta));
    let mut blocks = vec![text_block];
    blocks.extend(images);
    Ok(blocks)
}

/// Send a typed ACP prompt. Supported images are carried as real ImageContent;
/// other files are explicit @path references so the runtime's read_file tool
/// can load them on demand.
pub async fn prompt_with_attachments(
    tx: &AcpAgentTx,
    session_id: &str,
    text: &str,
    attachments: &[String],
    display_text: Option<&str>,
) -> Result<()> {
    let blocks = build_prompt_blocks(text, attachments, display_text)?;
    let max_retries = 2;
    let mut delay_secs = 30u64;
    for attempt in 0..=max_retries {
        tracing::info!(
            session_id,
            text_len = text.len(),
            attempt,
            "echoagent: prompt send"
        );
        let req = acp::PromptRequest::new(session_id.to_string(), blocks.clone());
        match acp_send(req, tx).await {
            Ok(resp) => {
                let _ = resp;
                if attempt > 0 {
                    tracing::info!(
                        session_id,
                        attempt,
                        "echoagent: prompt succeeded after retry"
                    );
                } else {
                    tracing::info!(session_id, "echoagent: prompt turn completed");
                }
                let _ = resp;
                return Ok(());
            }
            Err(e) => {
                let err_str = format!("{e:?}");
                let is_rate_limit = err_str.contains("-32003")
                    && (err_str.contains("429")
                        || err_str.contains("Rate limited")
                        || err_str.contains("rate limit"));
                if is_rate_limit && attempt < max_retries {
                    tracing::warn!(
                        session_id,
                        attempt,
                        delay_secs,
                        "echoagent: prompt rate-limited, retrying after delay"
                    );
                    // Emit a status event so the frontend can show "retrying in Ns".
                    tokio::time::sleep(std::time::Duration::from_secs(delay_secs)).await;
                    delay_secs *= 2;
                    continue;
                }
                tracing::error!(error = ?e, "echoagent: prompt acp_send FAILED");
                return Err(anyhow!("prompt: {e:?}"));
            }
        }
    }
    unreachable!()
}

/// Switch the model used by an existing session. Maps to EchoAgent's
/// `session/set_model` ACP method (`SetSessionModelRequest`). EchoAgent will
/// re-derive sampling config, sync the API key, and broadcast a
/// `ModelChanged` notification.
///
/// Caveat: if the session has existing turns and the new model requires a
/// different agent harness, EchoAgent rejects this with
/// `MODEL_SWITCH_INCOMPATIBLE_AGENT` — surface that error to the caller so
/// the UI can prompt for a new session.
pub async fn set_session_model(tx: &AcpAgentTx, session_id: &str, model_id: &str) -> Result<()> {
    tracing::info!(session_id, model_id, "echoagent: set_session_model send");
    let req = acp::SetSessionModelRequest::new(
        acp::SessionId::new(session_id.to_string()),
        acp::ModelId::new(std::sync::Arc::from(model_id)),
    );
    let _: acp::SetSessionModelResponse = acp_send(req, tx).await.map_err(|e| {
        tracing::error!(session_id, model_id, error = ?e, "echoagent: set_session_model FAILED");
        anyhow!("set_session_model: {e:?}")
    })?;
    tracing::info!(session_id, model_id, "echoagent: set_session_model OK");
    Ok(())
}

/// Cancel the in-flight prompt for a session.
///
/// Cancel is a *notification* (no response). We build the `AcpAgentMessage::Cancel`
/// variant directly and send it on the channel — the agent's gateway receiver
/// dispatches it to `MvpAgent::cancel`. A throwaway oneshot satisfies the
/// `AcpArgs.response_tx` shape; the agent may or may not send on it.
pub async fn cancel(tx: &AcpAgentTx, session_id: &str) -> Result<()> {
    use xai_acp_lib::{AcpAgentMessage, AcpArgs};
    let notif = acp::CancelNotification::new(acp::SessionId::new(session_id.to_string()));
    let (response_tx, _response_rx) = tokio::sync::oneshot::channel();
    let msg = AcpAgentMessage::Cancel(AcpArgs {
        request: notif,
        response_tx,
    });
    tx.send(msg).map_err(|e| anyhow!("cancel send: {e}"))?;
    Ok(())
}

/// Rename a session by calling EchoAgent's `echo.agent/session/rename` extension method.
///
/// This is the canonical path (see `xai-grok-shell/src/extensions/session_admin.rs:60`):
/// it writes `summary.json`'s `generated_title` with `title_is_manual=true`,
/// refreshes the FTS search index, and broadcasts `SessionSummaryGenerated`.
/// **Do not** edit `summary.json` directly — the agent holds the Summary in
/// memory and flushes periodically, so a direct write would be clobbered.
///
/// `cwd` is optional but recommended: EchoAgent uses it to narrow the summary scan
/// when locating the session on disk.
pub async fn rename_session(
    tx: &AcpAgentTx,
    session_id: &str,
    title: &str,
    cwd: Option<&str>,
) -> Result<()> {
    let params = crate::ext::raw_params(&serde_json::json!({
        "sessionId": session_id,
        "title": title,
        // `cwd` null is fine — EchoAgent treats it as "search all sessions".
        "cwd": cwd,
    }));
    let _: acp::ExtResponse =
        crate::ext::call_ext_value(tx, "echo.agent/session/rename", params).await?;
    Ok(())
}

/// Delete a session's persisted history by calling EchoAgent's
/// `echo.agent/session/delete` extension method (session_admin.rs:230).
///
/// Removes the on-disk session directory, drops it from the FTS index, and
/// if the session is live in memory, requests a graceful shutdown. The
/// sidebar's local entry is removed by the frontend on success.
pub async fn delete_session(tx: &AcpAgentTx, session_id: &str, cwd: Option<&str>) -> Result<()> {
    let params = crate::ext::raw_params(&serde_json::json!({
        "sessionId": session_id,
        "cwd": cwd,
    }));
    let _: acp::ExtResponse =
        crate::ext::call_ext_value(tx, "echo.agent/session/delete", params).await?;
    Ok(())
}

/// Fetch a session's context-window snapshot via EchoAgent's `echo.agent/session/info`
/// extension method (session/handlers/session.rs). The response is the
/// camelCase `SessionInfoResponse` — its `context` field carries
/// used/total/usagePct plus the token breakdown (system prompt, tool
/// definitions, messages, skills/MCP categories) shown by the composer pill.
/// Returned as raw JSON: the wire shape is owned by EchoAgent, so we pass it
/// through rather than mirroring the struct in Rust.
pub async fn session_info(tx: &AcpAgentTx, session_id: &str) -> Result<serde_json::Value> {
    let params = crate::ext::raw_params(&serde_json::json!({
        "sessionId": session_id,
    }));
    let resp: serde_json::Value =
        crate::ext::call_ext(tx, "echo.agent/session/info", params).await?;
    // Unlike most echo.agent/* methods, session/info wraps its payload in
    // `ExtMethodResult { result, error? }` (session/result.rs) — and reports
    // "session not live" as success({}) rather than an error. Unwrap the
    // envelope so the frontend always sees the bare SessionInfoResponse.
    if let Some(result) = resp.get("result") {
        return Ok(result.clone());
    }
    Ok(resp)
}

/// Fetch a session's cumulative token usage via EchoAgent's `echo.agent/session/usage`
/// extension method (extensions/usage.rs). The response's `usage` field is a
/// `PromptUsage` whose totals include `inputTokens` and `cachedReadTokens` —
/// the frontend derives the average cache hit rate from those two.
pub async fn session_usage(tx: &AcpAgentTx, session_id: &str) -> Result<serde_json::Value> {
    let params = crate::ext::raw_params(&serde_json::json!({
        "sessionId": session_id,
    }));
    crate::ext::call_ext(tx, "echo.agent/session/usage", params).await
}

#[cfg(test)]
mod tests {
    //! End-to-end smoke test for the embedded EchoAgent runtime (no model call):
    //! spawn the agent thread, run the ACP `initialize` handshake, create a
    //! session, and verify EchoAgent connects to the team MCP server. `new_session`
    //! exercises the full `AgentBuilder::build` path — including the client
    //! side MCP merge (team_mcp.rs) — so a grok-build upgrade that breaks
    //! toolset assembly or the MCP handshake fails here rather than at first
    //! chat in the GUI. Marked `#[ignore]`: it spawns a real agent thread
    //! against the user's `~/.echo-agent` config (~10s). Run with
    //! `cargo test --lib -- --ignored spawn_smoke`.
    use super::*;

    #[test]
    fn document_attachment_keeps_model_reference_and_replay_metadata() {
        let attachments = vec!["/tmp/AI数据集平台-数据回流方案.docx".to_string()];
        let blocks = build_prompt_blocks(
            "<system-reminder>hidden</system-reminder>\n\n请优化文档",
            &attachments,
            Some("请优化文档"),
        )
        .expect("document attachment should not require reading the file");

        let acp::ContentBlock::Text(text) = &blocks[0] else {
            panic!("first prompt block must be text");
        };
        assert!(text.text.contains("- @/tmp/AI数据集平台-数据回流方案.docx"));
        let meta = text.meta.as_ref().expect("replay metadata");
        assert_eq!(
            meta.get("displayText"),
            Some(&serde_json::json!("请优化文档"))
        );
        assert_eq!(
            meta.get("echoAgentAttachments"),
            Some(&serde_json::json!(attachments)),
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "spawns a real agent thread against ~/.echo-agent (~10s)"]
    async fn spawn_smoke_spawn_initialize_new_session() {
        let cwd = std::env::temp_dir();

        // 0. 先起 team MCP server —— new_session 会把它注入 EchoAgent（这是去
        //    补丁化后的工具注入路径，替代原 patch 02）。
        crate::team_mcp::serve();

        // 1. Spawn: config load → resolve_runtime_fields → bootstrap →
        //    MvpAgent thread.
        let handle = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            tokio::task::spawn_blocking({
                let cwd = cwd.clone();
                move || spawn_agent_runtime(cwd)
            }),
        )
        .await
        .expect("spawn_agent_runtime timed out (60s)")
        .expect("spawn task join failed")
        .expect("spawn_agent_runtime failed");

        // 2. ACP initialize handshake: protocol version + auth methods.
        let init = tokio::time::timeout(std::time::Duration::from_secs(30), initialize(&handle.tx))
            .await
            .expect("initialize timed out (30s)")
            .expect("initialize failed");
        assert!(init.ok, "initialize reported not-ok");
        // 3. New session: runs AgentBuilder::build + merges the client-side
        //    MCP server entry (team tools live as echoagent__* now).
        let session_id = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            new_session(&handle.tx, &cwd, init.default_model_id.as_deref()),
        )
        .await
        .expect("new_session timed out (60s)")
        .expect("new_session failed");
        assert!(!session_id.is_empty(), "empty session id");

        // 4. EchoAgent 的 MCP client 必须真的连上 team MCP server（initialize
        //    握手完成）。轮询最多 10s —— EchoAgent 异步启动 server 连接。
        let mut connected = false;
        for _ in 0..100 {
            if crate::team_mcp::client_connected() {
                connected = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(
            connected,
            "EchoAgent never connected to the team MCP server — tools would be missing"
        );

        // 5. Clean shutdown: cancel the agent thread and join it.
        handle.cancel.cancel();
        if let Some(thread) = handle.thread {
            let _ = tokio::task::spawn_blocking(move || thread.join()).await;
        }
    }
}
