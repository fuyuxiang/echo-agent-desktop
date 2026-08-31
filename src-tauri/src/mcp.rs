//! Connectors panel — drives EchoAgent's `echo.agent/mcp/*` extension methods.
//!
//! MCP server configs live in `~/.echo-agent/config.toml` as `[mcp_servers.<name>]`
//! tables (see `xai-grok-config-types/src/mcp.rs` for the full schema). EchoAgent
//! owns the canonical state. With an active session we use its ACP CRUD methods
//! for hot start/stop; without a session we persist through the Runtime's public
//! config helpers so connector setup remains fully usable offline. Health changes
//! arrive via `echo.agent/mcp/server_status` (forwarded as `agent://mcp-status`).

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use agent_client_protocol as acp;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::AppState;
use crate::ext::{call_ext, call_ext_value, raw_params};

/// One MCP server entry surfaced to the UI. Mirrors the fields of EchoAgent's
/// `McpServerEntry` (`xai-grok-shell/src/inspect/mod.rs:227`) plus the live
/// status that arrives via `echo.agent/mcp/server_status` notifications.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerEntry {
    pub name: String,
    #[serde(default)]
    pub display_name: Option<String>,
    /// Transport kind: "stdio" | "streamable_http" (EchoAgent also has "sse" as a
    /// sub-variant of streamable_http; we normalize to the transport name).
    #[serde(default)]
    pub transport: Option<String>,
    /// For stdio: the command. For http: the URL.
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub enabled: bool,
    /// Where the config came from: "user" | "project" | "bundled" | ...
    #[serde(default)]
    pub source: Option<String>,
    /// Reason the server is disabled (if any) — surfaced by EchoAgent inspect.
    #[serde(default)]
    pub disabled_reason: Option<String>,
    /// Vendor/plugin that contributed this server, if any.
    #[serde(default)]
    pub vendor: Option<String>,
    /// Live session health: ready | initializing | setuprequired | unavailable.
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub live: bool,
    #[serde(default)]
    pub auth_required: bool,
    #[serde(default)]
    pub setup_required: bool,
    #[serde(default)]
    pub setup: Option<xai_grok_shell::util::config::McpSetupConfig>,
    #[serde(default)]
    pub setup_values: HashMap<String, String>,
    #[serde(default)]
    pub tools: Vec<McpToolEntry>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Only user-global config entries are deletable from this panel.
    #[serde(default)]
    pub editable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolEntry {
    pub name: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

/// Exact (forward-compatible) subset of the embedded Runtime's list wire shape.
/// The transport is a flattened tagged enum, while health lives under `session`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpServerWire {
    name: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    source_label: Option<String>,
    #[serde(default)]
    setup: Option<xai_grok_shell::util::config::McpSetupConfig>,
    #[serde(default)]
    setup_values: Option<HashMap<String, String>>,
    #[serde(rename = "type", default)]
    kind: Option<String>,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: Vec<McpEnvWire>,
    #[serde(default)]
    session: Option<McpSessionWire>,
}

#[derive(Debug, Deserialize)]
struct McpEnvWire {
    name: String,
    value: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpSessionWire {
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    tools: Vec<McpToolEntry>,
    #[serde(default)]
    auth_required: bool,
    #[serde(default)]
    setup_required: bool,
}

/// The list endpoint returns either a bare array or `{ servers: [...] }`,
/// depending on the EchoAgent build. Accept both.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum McpListResponse {
    Array(Vec<McpServerWire>),
    Wrapped {
        #[serde(default)]
        servers: Vec<McpServerWire>,
    },
}

impl McpListResponse {
    fn into_servers(self) -> Vec<McpServerWire> {
        match self {
            McpListResponse::Array(v) => v,
            McpListResponse::Wrapped { servers } => servers,
        }
    }
}

/// Frontend payload for creating/updating an MCP server. We keep this loose
/// (transport-discriminated) so the UI can support both stdio and HTTP without
/// a round of protocol churn.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpUpsertRequest {
    pub name: String,
    /// "stdio" or "http". http covers both streamable_http and SSE.
    pub transport: String,
    /// stdio: the executable command. http: the URL.
    pub target: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub bearer_token_env_var: Option<String>,
    #[serde(default)]
    pub oauth_client_id: Option<String>,
    #[serde(default)]
    pub oauth_client_secret_env_var: Option<String>,
    #[serde(default)]
    pub oauth_scopes: Vec<String>,
    #[serde(default)]
    pub startup_timeout_sec: Option<u64>,
    #[serde(default)]
    pub tool_timeout_sec: Option<u64>,
    /// Full Runtime options retained by the raw editor. These matter for
    /// connector setup forms, nested OAuth declarations and large tool output.
    #[serde(default)]
    pub oauth: Option<xai_grok_shell::util::config::McpJsonOAuthBlock>,
    #[serde(default)]
    pub setup: Option<xai_grok_shell::util::config::McpSetupConfig>,
    #[serde(default)]
    pub tool_timeouts: HashMap<String, u64>,
    #[serde(default)]
    pub expose_image_base64: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpMutationResult {
    pub persisted: bool,
    pub applied_live: bool,
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// List configured MCP servers. `session_id` is optional — EchoAgent's
/// `McpListRequest` accepts it (camelCase `sessionId`) to enrich entries with
/// live session state; without it the agent-level catalog is returned.
#[tauri::command]
pub async fn mcp_list(
    state: State<'_, AppState>,
    session_id: Option<String>,
    refresh: Option<bool>,
) -> Result<Vec<McpServerEntry>, String> {
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    mcp_list_with_tx_cache(&tx, session_id, !refresh.unwrap_or(false)).await
}

/// Internal form used by automations to ensure every selected connector is
/// configured and enabled before a background run is dispatched.
pub async fn mcp_list_with_tx(
    tx: &xai_acp_lib::AcpAgentTx,
    session_id: Option<String>,
) -> Result<Vec<McpServerEntry>, String> {
    mcp_list_with_tx_cache(tx, session_id, true).await
}

async fn mcp_list_with_tx_cache(
    tx: &xai_acp_lib::AcpAgentTx,
    session_id: Option<String>,
    cache: bool,
) -> Result<Vec<McpServerEntry>, String> {
    let params = raw_params(&serde_json::json!({
        "sessionId": session_id,
        "cache": cache,
    }));
    let v: McpListResponse = call_ext(tx, "echo.agent/mcp/list", params)
        .await
        .map_err(|e| e.to_string())?;
    Ok(v.into_servers().into_iter().map(map_wire_entry).collect())
}

fn map_wire_entry(wire: McpServerWire) -> McpServerEntry {
    let session = wire.session;
    let enabled = session.as_ref().map(|s| s.enabled).unwrap_or(true);
    let kind = wire.kind.as_deref().unwrap_or("unknown");
    let transport = match kind {
        "http" => "streamable_http",
        "managedGateway" => "managed_gateway",
        other => other,
    };
    let target = match transport {
        "stdio" => wire.command.clone(),
        "streamable_http" | "sse" => wire.url.clone(),
        _ => None,
    };
    let source = wire.source.unwrap_or_else(|| "local".into());
    let editable = source == "local" && user_config_has_server(&wire.name);
    let env = wire
        .env
        .into_iter()
        .map(|item| (item.name, item.value))
        .collect();
    McpServerEntry {
        name: wire.name,
        display_name: wire.display_name,
        transport: Some(transport.into()),
        target,
        enabled,
        source: Some(source),
        disabled_reason: (!enabled).then_some("已在本地配置中停用".into()),
        vendor: wire.source_label,
        status: session.as_ref().and_then(|s| s.status.clone()),
        live: session.is_some(),
        auth_required: session.as_ref().is_some_and(|s| s.auth_required),
        setup_required: session.as_ref().is_some_and(|s| s.setup_required),
        setup: wire.setup,
        setup_values: wire.setup_values.unwrap_or_default(),
        tools: session.map(|s| s.tools).unwrap_or_default(),
        args: wire.args,
        env,
        editable,
    }
}

/// Add or update an MCP server. Translates the frontend payload into the
/// `[mcp_servers.<name>]` shape EchoAgent expects (see McpServerTransportConfig).
#[tauri::command]
pub async fn mcp_upsert(
    state: State<'_, AppState>,
    session_id: Option<String>,
    server: McpUpsertRequest,
) -> Result<McpMutationResult, String> {
    validate_upsert_request(&server)?;
    let tx = state.tx.lock().unwrap().clone();
    apply_upsert(tx.as_ref(), session_id.as_deref(), &server).await
}

/// Delete an MCP server by name.
#[tauri::command]
pub async fn mcp_delete(
    state: State<'_, AppState>,
    session_id: Option<String>,
    name: String,
) -> Result<McpMutationResult, String> {
    validate_server_name(&name)?;
    let tx = state.tx.lock().unwrap().clone();
    apply_delete(tx.as_ref(), session_id.as_deref(), &name).await
}

/// Enable or disable an MCP server at runtime (no restart needed).
#[tauri::command]
pub async fn mcp_toggle(
    state: State<'_, AppState>,
    session_id: Option<String>,
    name: String,
    enabled: bool,
) -> Result<McpMutationResult, String> {
    validate_server_name(&name)?;
    let tx = state.tx.lock().unwrap().clone();
    apply_toggle(tx.as_ref(), session_id.as_deref(), &name, enabled).await
}

/// Resolve a connector's Runtime-provided setup schema and start it in the
/// current session. Setup is inherently session-scoped because resolution
/// includes project/plugin policy and performs a live connection probe.
#[tauri::command]
pub async fn mcp_setup(
    state: State<'_, AppState>,
    session_id: String,
    name: String,
    values: HashMap<String, String>,
) -> Result<(), String> {
    validate_server_name(&name)?;
    if session_id.trim().is_empty() {
        return Err("完成 MCP Setup 需要一个活动会话".into());
    }
    if values
        .iter()
        .any(|(key, value)| key.trim().is_empty() || value.trim().is_empty())
    {
        return Err("Setup 字段名和值不能为空".into());
    }
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("本地 Runtime 尚未初始化")?;
    let params = raw_params(&serde_json::json!({
        "sessionId": session_id,
        "serverName": name,
        "values": values,
    }));
    let _: acp::ExtResponse = call_ext_value(&tx, "echo.agent/mcp/setup", params)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Enable/disable one advertised tool for the current session.
#[tauri::command]
pub async fn mcp_toggle_tool(
    state: State<'_, AppState>,
    session_id: String,
    server_name: String,
    tool_name: String,
    enabled: bool,
) -> Result<(), String> {
    validate_server_name(&server_name)?;
    if session_id.trim().is_empty() || tool_name.trim().is_empty() {
        return Err("切换 MCP 工具需要活动会话和有效工具名".into());
    }
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("本地 Runtime 尚未初始化")?;
    let params = raw_params(&serde_json::json!({
        "session_id": session_id,
        "server_name": server_name,
        "tool_name": tool_name,
        "enabled": enabled,
    }));
    let _: acp::ExtResponse = call_ext_value(&tx, "echo.agent/mcp/toggle_tool", params)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

async fn apply_upsert(
    tx: Option<&xai_acp_lib::AcpAgentTx>,
    session_id: Option<&str>,
    server: &McpUpsertRequest,
) -> Result<McpMutationResult, String> {
    validate_upsert_request(server)?;
    if server.enabled == Some(false) {
        persist_server_config(server).await?;
        mirror_single_server(server, false)?;
        let mut result = McpMutationResult {
            persisted: true,
            applied_live: false,
            warnings: Vec::new(),
        };
        if let (Some(session_id), Some(tx)) = (session_id.filter(|value| !value.is_empty()), tx) {
            let params = raw_params(&serde_json::json!({
                "session_id": session_id,
                "server_name": server.name,
                "enabled": false,
            }));
            let live: Result<acp::ExtResponse, _> =
                call_ext_value(tx, "echo.agent/mcp/toggle", params).await;
            match live {
                Ok(_) => result.applied_live = true,
                Err(error) => result
                    .warnings
                    .push(format!("配置已保存，但当前会话热停用失败：{error}")),
            }
        } else if session_id.is_some() {
            result
                .warnings
                .push("配置已保存，但本地 Runtime 尚未初始化；将在新会话中生效".into());
        } else {
            result
                .warnings
                .push("已按停用状态保存，将对新会话生效".into());
        }
        return Ok(result);
    }
    if let (Some(session_id), Some(tx)) = (session_id.filter(|value| !value.is_empty()), tx) {
        let payload = build_upsert_payload(session_id, server)?;
        let params = raw_params(&payload);
        let live: Result<acp::ExtResponse, _> =
            call_ext_value(tx, "echo.agent/mcp/upsert", params).await;
        return match live {
            Ok(_) => {
                mirror_single_server(server, false)?;
                Ok(McpMutationResult {
                    persisted: true,
                    applied_live: true,
                    warnings: Vec::new(),
                })
            }
            Err(error) => {
                persist_server_config(server).await?;
                mirror_single_server(server, false)?;
                Ok(McpMutationResult {
                    persisted: true,
                    applied_live: false,
                    warnings: vec![format!("配置已保存，但当前会话热加载失败：{error}")],
                })
            }
        };
    } else if session_id.is_some() {
        persist_server_config(server).await?;
        mirror_single_server(server, false)?;
        return Ok(McpMutationResult {
            persisted: true,
            applied_live: false,
            warnings: vec!["配置已保存，但本地 Runtime 尚未初始化；将在新会话中生效".into()],
        });
    }
    persist_server_config(server).await?;
    mirror_single_server(server, false)?;
    Ok(McpMutationResult {
        persisted: true,
        applied_live: false,
        warnings: vec!["配置已保存，将在下次创建会话时启动".into()],
    })
}

async fn apply_delete(
    tx: Option<&xai_acp_lib::AcpAgentTx>,
    session_id: Option<&str>,
    name: &str,
) -> Result<McpMutationResult, String> {
    let mut warnings = Vec::new();
    let mut applied_live = false;
    let was_user_config = user_config_has_server(name);
    if let (Some(session_id), Some(tx)) = (session_id.filter(|value| !value.is_empty()), tx) {
        let params = raw_params(&serde_json::json!({
            "session_id": session_id,
            "server_name": name,
        }));
        let live: Result<acp::ExtResponse, _> =
            call_ext_value(tx, "echo.agent/mcp/delete", params).await;
        match live {
            Ok(_) => applied_live = true,
            Err(error) => warnings.push(format!("当前会话热卸载失败：{error}")),
        }
    } else if session_id.is_some() {
        warnings.push("本地 Runtime 尚未初始化；已删除持久化配置".into());
    }
    // The Runtime delete persists before resolving the session. Calling this
    // again is idempotent and also covers the no-session/stale-session path.
    let path = runtime_config_path();
    let existed = xai_grok_shell::util::config::delete_mcp_server_config_at(&path, name)
        .await
        .map_err(|e| format!("删除 MCP 配置失败：{e}"))?;
    if path.exists() {
        crate::paths::harden_private_file(&path)?;
    }
    if !existed && !applied_live && !was_user_config {
        return Err(format!("MCP 服务「{name}」不是可删除的用户配置"));
    }
    mirror_delete_server(name)?;
    Ok(McpMutationResult {
        persisted: true,
        applied_live,
        warnings,
    })
}

async fn apply_toggle(
    tx: Option<&xai_acp_lib::AcpAgentTx>,
    session_id: Option<&str>,
    name: &str,
    enabled: bool,
) -> Result<McpMutationResult, String> {
    let mut warnings = Vec::new();
    let mut applied_live = false;
    if let (Some(session_id), Some(tx)) = (session_id.filter(|value| !value.is_empty()), tx) {
        let params = raw_params(&serde_json::json!({
            "session_id": session_id,
            "server_name": name,
            "enabled": enabled,
        }));
        let live: Result<acp::ExtResponse, _> =
            call_ext_value(tx, "echo.agent/mcp/toggle", params).await;
        match live {
            Ok(_) => applied_live = true,
            Err(error) => warnings.push(format!("当前会话热切换失败：{error}")),
        }
    } else if session_id.is_some() {
        warnings.push("本地 Runtime 尚未初始化；状态将在新会话中生效".into());
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    xai_grok_shell::util::config::save_mcp_server_enabled_in(name, enabled, &cwd)
        .await
        .map_err(|e| format!("保存 MCP 启用状态失败：{e}"))?;
    mirror_toggle_server(name, enabled)?;
    if session_id.is_none() {
        warnings.push("状态已保存，将对新会话生效".into());
    }
    Ok(McpMutationResult {
        persisted: true,
        applied_live,
        warnings,
    })
}

/// Translate the frontend payload to the JSON EchoAgent's `echo.agent/mcp/upsert` expects.
///
/// EchoAgent's `McpUpsertRequest` (`xai-grok-shell/src/extensions/mcp.rs`) is:
/// ```json
/// { "session_id": "...", "server_name": "...", <flattened McpServerConfig> }
/// ```
/// where `McpServerConfig` flattens a `McpServerTransportConfig`:
/// ```toml
/// [mcp_servers.filesystem]            # stdio
/// command = "npx"
/// args = ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
///
/// [mcp_servers.linear]                # streamable_http
/// url = "https://mcp.linear.app/mcp"
/// ```
/// NOTE: the wire keys are snake_case (`session_id` / `server_name`) — EchoAgent's
/// request struct has no `rename_all`, unlike `mcp/list` which takes
/// camelCase `sessionId`.
fn build_upsert_payload(
    session_id: &str,
    server: &McpUpsertRequest,
) -> Result<serde_json::Value, String> {
    let mut payload = serde_json::Map::new();
    payload.insert("session_id".into(), session_id.into());
    payload.insert("server_name".into(), server.name.clone().into());
    match server.transport.as_str() {
        "stdio" => {
            payload.insert("command".into(), server.target.clone().into());
            if !server.args.is_empty() {
                payload.insert(
                    "args".into(),
                    server
                        .args
                        .iter()
                        .cloned()
                        .map(serde_json::Value::from)
                        .collect::<Vec<_>>()
                        .into(),
                );
            }
            if !server.env.is_empty() {
                payload.insert("env".into(), serde_json::to_value(&server.env).unwrap());
            }
            if let Some(cwd) = &server.cwd {
                payload.insert("cwd".into(), cwd.clone().into());
            }
        }
        "http" | "streamable_http" | "sse" => {
            payload.insert("url".into(), server.target.clone().into());
            if server.transport == "sse" {
                payload.insert("type".into(), "sse".into());
            }
            if !server.headers.is_empty() {
                payload.insert(
                    "headers".into(),
                    serde_json::to_value(&server.headers).unwrap(),
                );
            }
            if let Some(value) = &server.bearer_token_env_var {
                payload.insert("bearer_token_env_var".into(), value.clone().into());
            }
            if let Some(value) = &server.oauth_client_id {
                payload.insert("oauth_client_id".into(), value.clone().into());
            }
            if let Some(value) = &server.oauth_client_secret_env_var {
                payload.insert("oauth_client_secret_env_var".into(), value.clone().into());
            }
            if !server.oauth_scopes.is_empty() {
                payload.insert(
                    "oauth_scopes".into(),
                    serde_json::to_value(&server.oauth_scopes).unwrap(),
                );
            }
        }
        other => {
            return Err(format!(
                "unknown transport '{other}': expected 'stdio' or 'http'"
            ));
        }
    }
    if let Some(enabled) = server.enabled {
        payload.insert("enabled".into(), enabled.into());
    }
    if let Some(value) = server.startup_timeout_sec {
        payload.insert("startup_timeout_sec".into(), value.into());
    }
    if let Some(value) = server.tool_timeout_sec {
        payload.insert("tool_timeout_sec".into(), value.into());
    }
    if let Some(value) = &server.oauth {
        payload.insert(
            "oauth".into(),
            serde_json::to_value(value).map_err(|e| format!("序列化 OAuth 配置失败：{e}"))?,
        );
    }
    if let Some(value) = &server.setup {
        payload.insert(
            "setup".into(),
            serde_json::to_value(value).map_err(|e| format!("序列化 Setup 配置失败：{e}"))?,
        );
    }
    if !server.tool_timeouts.is_empty() {
        payload.insert(
            "tool_timeouts".into(),
            serde_json::to_value(&server.tool_timeouts)
                .map_err(|e| format!("序列化逐工具超时失败：{e}"))?,
        );
    }
    if let Some(value) = server.expose_image_base64 {
        payload.insert("expose_image_base64".into(), value.into());
    }
    Ok(serde_json::Value::Object(payload))
}

fn validate_server_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 80 {
        return Err("MCP 服务名称必须为 1–80 个字符".into());
    }
    if trimmed.starts_with("managed_gateway:")
        || trimmed.chars().any(char::is_control)
        || trimmed.chars().any(|ch| matches!(ch, '\n' | '\r'))
    {
        return Err("MCP 服务名称包含保留前缀或非法字符".into());
    }
    Ok(())
}

fn validate_upsert_request(server: &McpUpsertRequest) -> Result<(), String> {
    validate_server_name(&server.name)?;
    if server.target.trim().is_empty() {
        return Err("MCP 命令或 URL 不能为空".into());
    }
    match server.transport.as_str() {
        "stdio" => {}
        "http" | "streamable_http" | "sse" => {
            let url =
                url::Url::parse(server.target.trim()).map_err(|e| format!("MCP URL 无效：{e}"))?;
            if !matches!(url.scheme(), "http" | "https") {
                return Err("MCP URL 仅支持 http:// 或 https://".into());
            }
            if url.scheme() == "http"
                && !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1"))
            {
                return Err("远程 MCP 服务必须使用 HTTPS；HTTP 仅允许本机回环地址".into());
            }
        }
        other => return Err(format!("不支持的 MCP 传输类型：{other}")),
    }
    for (label, value) in [
        ("启动超时", server.startup_timeout_sec),
        ("工具超时", server.tool_timeout_sec),
    ] {
        if value.is_some_and(|v| v == 0 || v > 3600) {
            return Err(format!("{label}必须在 1–3600 秒之间"));
        }
    }
    if server
        .tool_timeouts
        .iter()
        .any(|(name, value)| name.trim().is_empty() || *value == 0 || *value > 3600)
    {
        return Err("逐工具超时的名称不能为空，时长必须在 1–3600 秒之间".into());
    }
    if server.env.keys().any(|key| key.trim().is_empty())
        || server.headers.keys().any(|key| key.trim().is_empty())
    {
        return Err("环境变量名和 Header 名不能为空".into());
    }
    Ok(())
}

fn runtime_config_path() -> PathBuf {
    crate::paths::echo_agent_home_dir().join("config.toml")
}

fn request_to_runtime_config(
    server: &McpUpsertRequest,
) -> xai_grok_shell::util::config::McpServerConfig {
    use xai_grok_shell::util::config::{McpServerConfig, McpServerTransportConfig};
    let transport = match server.transport.as_str() {
        "stdio" => McpServerTransportConfig::Stdio {
            command: server.target.clone(),
            args: server.args.clone(),
            env: (!server.env.is_empty()).then(|| server.env.clone()),
            cwd: server.cwd.clone(),
        },
        _ => McpServerTransportConfig::StreamableHttp {
            url: server.target.clone(),
            transport_type: (server.transport == "sse").then(|| "sse".into()),
            bearer_token_env_var: server.bearer_token_env_var.clone(),
            headers: (!server.headers.is_empty()).then(|| server.headers.clone()),
            oauth_client_id: server.oauth_client_id.clone(),
            oauth_client_secret_env_var: server.oauth_client_secret_env_var.clone(),
            oauth_scopes: (!server.oauth_scopes.is_empty()).then(|| server.oauth_scopes.clone()),
        },
    };
    McpServerConfig {
        transport,
        enabled: server.enabled.unwrap_or(true),
        oauth: server.oauth.clone(),
        setup: server.setup.clone(),
        startup_timeout_sec: server.startup_timeout_sec,
        tool_timeout_sec: server.tool_timeout_sec,
        tool_timeouts: (!server.tool_timeouts.is_empty()).then(|| server.tool_timeouts.clone()),
        expose_image_base64: server.expose_image_base64,
    }
}

async fn persist_server_config(server: &McpUpsertRequest) -> Result<(), String> {
    let path = runtime_config_path();
    let config = request_to_runtime_config(server);
    xai_grok_shell::util::config::save_mcp_server_config_at(&path, &server.name, &config)
        .await
        .map_err(|e| format!("保存 MCP 配置失败：{e}"))?;
    crate::paths::harden_private_file(&path)?;
    if server.enabled == Some(false) {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        xai_grok_shell::util::config::save_mcp_server_enabled_in(&server.name, false, &cwd)
            .await
            .map_err(|e| format!("保存 MCP 停用状态失败：{e}"))?;
    }
    Ok(())
}

fn user_config_has_server(name: &str) -> bool {
    let content = match std::fs::read_to_string(runtime_config_path()) {
        Ok(content) => content,
        Err(_) => return false,
    };
    toml::from_str::<toml::Value>(&content)
        .ok()
        .and_then(|root| root.get("mcp_servers").cloned())
        .and_then(|servers| servers.as_table().cloned())
        .is_some_and(|servers| servers.contains_key(name))
}

fn read_user_config_requests() -> Result<Vec<McpUpsertRequest>, String> {
    use xai_grok_shell::util::config::{McpServerConfig, McpServerTransportConfig};
    let content = match std::fs::read_to_string(runtime_config_path()) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("读取 Runtime MCP 配置失败：{error}")),
    };
    let root: toml::Value = toml::from_str(&content)
        .map_err(|error| format!("config.toml 格式无效，无法读取 MCP 配置：{error}"))?;
    let disabled: HashSet<String> = root
        .get("disabled_mcp_servers")
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let Some(servers) = root.get("mcp_servers").and_then(|value| value.as_table()) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for (name, value) in servers {
        let config: McpServerConfig = value
            .clone()
            .try_into()
            .map_err(|error| format!("MCP 服务「{name}」配置无效：{error}"))?;
        let enabled = config.enabled;
        let startup_timeout_sec = config.startup_timeout_sec;
        let tool_timeout_sec = config.tool_timeout_sec;
        let oauth = config.oauth;
        let setup = config.setup;
        let tool_timeouts = config.tool_timeouts.unwrap_or_default();
        let expose_image_base64 = config.expose_image_base64;
        let (
            transport,
            target,
            args,
            env,
            headers,
            cwd,
            bearer_token_env_var,
            oauth_client_id,
            oauth_client_secret_env_var,
            oauth_scopes,
        ) = match config.transport {
            McpServerTransportConfig::Stdio {
                command,
                args,
                env,
                cwd,
            } => (
                "stdio".into(),
                command,
                args,
                env.unwrap_or_default(),
                HashMap::new(),
                cwd,
                None,
                None,
                None,
                Vec::new(),
            ),
            McpServerTransportConfig::StreamableHttp {
                url,
                transport_type,
                bearer_token_env_var,
                headers,
                oauth_client_id,
                oauth_client_secret_env_var,
                oauth_scopes,
            } => (
                if transport_type.as_deref() == Some("sse") {
                    "sse".into()
                } else {
                    "streamable_http".into()
                },
                url,
                Vec::new(),
                HashMap::new(),
                headers.unwrap_or_default(),
                None,
                bearer_token_env_var,
                oauth_client_id,
                oauth_client_secret_env_var,
                oauth_scopes.unwrap_or_default(),
            ),
        };
        out.push(McpUpsertRequest {
            name: name.clone(),
            transport,
            target,
            args,
            env,
            headers,
            enabled: Some(enabled && !disabled.contains(name)),
            cwd,
            bearer_token_env_var,
            oauth_client_id,
            oauth_client_secret_env_var,
            oauth_scopes,
            startup_timeout_sec,
            tool_timeout_sec,
            oauth,
            setup,
            tool_timeouts,
            expose_image_base64,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

// ---------- standalone mcp.json editor (截图 6 / 7) ----------
//
// The modal edits standard `{ "mcpServers": { ... } }` JSON. Runtime
// `config.toml` remains canonical; `mcp.json` is a private compatibility mirror
// for import/export and token-form prefills. Reads merge canonical entries and
// saves validate the whole document before synchronizing both representations.

/// Default content shown when the file does not exist yet.
const EMPTY_MCP_JSON: &str = "{\n  \"mcpServers\": {}\n}";

/// Raw `mcp.json` payload returned to the editor.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigFile {
    pub file_path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigSaveResult {
    pub server_count: usize,
    pub removed_count: usize,
    pub applied_live: bool,
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// Absolute path of the standalone MCP config file: `~/.echo-agent/mcp.json`.
fn mcp_json_path() -> PathBuf {
    crate::paths::echo_agent_home_dir().join("mcp.json")
}

/// Return the resolved config-file path (shown in the editor header).
#[tauri::command]
pub async fn mcp_config_path() -> Result<String, String> {
    Ok(mcp_json_path().to_string_lossy().into_owned())
}

/// Read the config file. Missing file yields the empty template (not an error)
/// so the editor always opens with valid JSON.
#[tauri::command]
pub async fn mcp_config_read() -> Result<McpConfigFile, String> {
    let path = mcp_json_path();
    let mut servers = read_mirror_servers();
    // config.toml is canonical. Merge its valid user entries into the editor,
    // while preserving mirror-only fields (for example token-form prefill env
    // on an HTTP connector) and legacy entries awaiting first save/import.
    for request in read_user_config_requests()? {
        let mut generated = request_to_mirror_json(&request);
        if let (Some(old), Some(next)) = (servers.get(&request.name), generated.as_object_mut()) {
            if let Some(env) = old.get("env") {
                next.entry("env").or_insert_with(|| env.clone());
            }
        }
        servers.insert(request.name, generated);
    }
    let content = serde_json::to_string_pretty(&serde_json::json!({ "mcpServers": servers }))
        .map_err(|e| format!("生成 mcp.json 编辑内容失败：{e}"))?;
    Ok(McpConfigFile {
        file_path: path.to_string_lossy().into_owned(),
        content,
    })
}

/// Validate the complete document, persist every entry to canonical Runtime
/// config and update the private JSON mirror. With an active session, changes
/// are also hot-applied; without one they take effect on the next session.
#[tauri::command]
pub async fn mcp_config_save(
    state: State<'_, AppState>,
    content: String,
    session_id: Option<String>,
) -> Result<McpConfigSaveResult, String> {
    let trimmed = content.trim();
    let parsed: serde_json::Value = if trimmed.is_empty() {
        serde_json::from_str(EMPTY_MCP_JSON).unwrap()
    } else {
        serde_json::from_str(trimmed).map_err(|e| format!("无效的 JSON：{e}"))?
    };
    if !parsed.is_object() {
        return Err("配置文件顶层必须是 JSON 对象".into());
    }
    let map = parsed
        .get("mcpServers")
        .map(|servers| {
            servers
                .as_object()
                .ok_or_else(|| "\"mcpServers\" 必须是 JSON 对象".to_string())
        })
        .transpose()?
        .cloned()
        .unwrap_or_default();

    // Validate the complete document before any mutation. One malformed entry
    // must never leave a half-applied config.
    let mut requests = Vec::with_capacity(map.len());
    for (name, config) in &map {
        let request =
            json_to_upsert(name, config).map_err(|e| format!("MCP 服务「{name}」配置无效：{e}"))?;
        validate_upsert_request(&request)
            .map_err(|e| format!("MCP 服务「{name}」配置无效：{e}"))?;
        requests.push(request);
    }

    let previous = read_mirror_servers();
    let mut previous_names: HashSet<String> = previous.keys().cloned().collect();
    previous_names.extend(
        read_user_config_requests()?
            .into_iter()
            .map(|request| request.name),
    );
    let incoming_names: HashSet<String> = map.keys().cloned().collect();
    let removed: Vec<String> = previous_names
        .iter()
        .filter(|name| !incoming_names.contains(*name))
        .cloned()
        .collect();
    let config_path = runtime_config_path();
    let config_snapshot = std::fs::read(&config_path).ok();
    let tx = state.tx.lock().unwrap().clone();
    let sid = session_id.filter(|value| !value.is_empty());
    let mut warnings = Vec::new();
    let mut applied_live = sid.is_some() && tx.is_some();

    // Use the Runtime extension for hot delete/upsert when a session exists.
    // Every operation is persisted again below, so stale sessions degrade to
    // "saved for next session" rather than losing the user's configuration.
    if let (Some(session_id), Some(tx)) = (sid.as_deref(), tx.as_ref()) {
        for name in &removed {
            let params = raw_params(&serde_json::json!({
                "session_id": session_id,
                "server_name": name,
            }));
            let result: Result<acp::ExtResponse, _> =
                call_ext_value(tx, "echo.agent/mcp/delete", params).await;
            if let Err(error) = result {
                applied_live = false;
                warnings.push(format!("服务「{name}」热卸载失败：{error}"));
            }
        }
        for request in &requests {
            if request.enabled == Some(false) {
                let params = raw_params(&serde_json::json!({
                    "session_id": session_id,
                    "server_name": request.name,
                    "enabled": false,
                }));
                let result: Result<acp::ExtResponse, _> =
                    call_ext_value(tx, "echo.agent/mcp/toggle", params).await;
                if let Err(error) = result {
                    applied_live = false;
                    warnings.push(format!("服务「{}」热停用失败：{error}", request.name));
                }
                continue;
            }
            let payload = build_upsert_payload(session_id, request)?;
            let params = raw_params(&payload);
            let result: Result<acp::ExtResponse, _> =
                call_ext_value(tx, "echo.agent/mcp/upsert", params).await;
            if let Err(error) = result {
                applied_live = false;
                warnings.push(format!("服务「{}」热加载失败：{error}", request.name));
            }
        }
    } else if sid.is_some() {
        warnings.push("本地 Runtime 尚未初始化；配置将在新会话中生效".into());
    }

    let persist_result = async {
        for request in &requests {
            persist_server_config(request).await?;
        }
        for name in &removed {
            xai_grok_shell::util::config::delete_mcp_server_config_at(&config_path, name)
                .await
                .map_err(|e| format!("删除 MCP 配置「{name}」失败：{e}"))?;
        }
        if config_path.exists() {
            crate::paths::harden_private_file(&config_path)?;
        }
        Ok::<(), String>(())
    }
    .await;
    if let Err(error) = persist_result {
        restore_config_snapshot(&config_path, config_snapshot.as_deref())?;
        return Err(error);
    }

    let normalized = if trimmed.is_empty() {
        EMPTY_MCP_JSON.as_bytes()
    } else {
        content.as_bytes()
    };
    if let Err(error) = crate::paths::write_private_file(&mcp_json_path(), normalized) {
        restore_config_snapshot(&config_path, config_snapshot.as_deref())?;
        return Err(format!("保存 mcp.json 失败：{error}"));
    }
    if sid.is_none() && (!requests.is_empty() || !removed.is_empty()) {
        warnings.push("配置已保存，将在下次创建会话时启动".into());
    }
    Ok(McpConfigSaveResult {
        server_count: requests.len(),
        removed_count: removed.len(),
        applied_live,
        warnings,
    })
}

/// Map one standard `mcpServers.<name>` value (the shape editors like EchoAgent
/// / Claude Desktop use) onto our `McpUpsertRequest` so we can reuse the EchoAgent
/// upsert path. Recognizes stdio (`command`) and http/sse (`url`) entries.
fn json_to_upsert(name: &str, cfg: &serde_json::Value) -> Result<McpUpsertRequest, String> {
    let obj = cfg
        .as_object()
        .ok_or_else(|| "server 配置必须是对象".to_string())?;
    validate_mcp_json_keys(obj)?;
    let get_str = |key: &str| optional_json_string(obj, key);
    let enabled = match obj.get("enabled") {
        Some(value) => Some(
            value
                .as_bool()
                .ok_or_else(|| "'enabled' 必须是布尔值".to_string())?,
        ),
        None => None,
    };
    let url = get_str("url")?
        .or(get_str("urlTemplate")?)
        .or(get_str("url_template")?);
    let command = get_str("command")?;
    if url.is_some() && command.is_some() {
        return Err("'command' 和 'url' 不能同时存在".into());
    }
    if let Some(url) = url {
        let transport = match get_str("type")?.as_deref() {
            Some("sse") => "sse".to_string(),
            Some("streamable-http") | Some("streamable_http") | Some("streamableHttp") => {
                "streamable_http".to_string()
            }
            Some("http") | None => "http".to_string(),
            Some(other) => return Err(format!("不支持的 HTTP MCP type：{other}")),
        };
        // EchoAgent connector manifests use `staticHeaders` (e.g. kdocs);
        // standard mcp.json uses `headers`. Merge both, `headers` winning.
        let mut headers = json_string_map(obj, "staticHeaders")?;
        headers.extend(json_string_map(obj, "headers")?);
        Ok(McpUpsertRequest {
            name: name.to_string(),
            transport,
            target: url,
            args: Vec::new(),
            env: HashMap::new(),
            headers,
            enabled,
            cwd: None,
            bearer_token_env_var: get_str("bearerTokenEnvVar")?
                .or(get_str("bearer_token_env_var")?),
            oauth_client_id: get_str("oauthClientId")?.or(get_str("oauth_client_id")?),
            oauth_client_secret_env_var: get_str("oauthClientSecretEnvVar")?
                .or(get_str("oauth_client_secret_env_var")?),
            oauth_scopes: json_string_array_alias(obj, "oauthScopes", "oauth_scopes")?,
            startup_timeout_sec: json_u64_alias(obj, "startupTimeoutSec", "startup_timeout_sec")?,
            tool_timeout_sec: json_u64_alias(obj, "toolTimeoutSec", "tool_timeout_sec")?,
            oauth: json_typed(obj, "oauth")?,
            setup: json_typed(obj, "setup")?,
            tool_timeouts: json_u64_map_alias(obj, "toolTimeouts", "tool_timeouts")?,
            expose_image_base64: json_bool_alias(obj, "exposeImageBase64", "expose_image_base64")?,
        })
    } else if let Some(command) = command {
        let args = json_string_array(obj, "args")?;
        let env = json_string_map(obj, "env")?;
        Ok(McpUpsertRequest {
            name: name.to_string(),
            transport: "stdio".to_string(),
            target: command,
            args,
            env,
            headers: HashMap::new(),
            enabled,
            cwd: get_str("cwd")?,
            bearer_token_env_var: None,
            oauth_client_id: None,
            oauth_client_secret_env_var: None,
            oauth_scopes: Vec::new(),
            startup_timeout_sec: json_u64_alias(obj, "startupTimeoutSec", "startup_timeout_sec")?,
            tool_timeout_sec: json_u64_alias(obj, "toolTimeoutSec", "tool_timeout_sec")?,
            oauth: json_typed(obj, "oauth")?,
            setup: json_typed(obj, "setup")?,
            tool_timeouts: json_u64_map_alias(obj, "toolTimeouts", "tool_timeouts")?,
            expose_image_base64: json_bool_alias(obj, "exposeImageBase64", "expose_image_base64")?,
        })
    } else {
        Err("缺少 'command' 或 'url' 字段".to_string())
    }
}

fn validate_mcp_json_keys(
    object: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    const SUPPORTED: &[&str] = &[
        "args",
        "bearerTokenEnvVar",
        "bearer_token_env_var",
        "command",
        "cwd",
        "enabled",
        "env",
        "exposeImageBase64",
        "expose_image_base64",
        "headers",
        "oauth",
        "oauthClientId",
        "oauthClientSecretEnvVar",
        "oauthScopes",
        "oauth_client_id",
        "oauth_client_secret_env_var",
        "oauth_scopes",
        "setup",
        "staticHeaders",
        "startupTimeoutSec",
        "startup_timeout_sec",
        "toolTimeoutSec",
        "toolTimeouts",
        "tool_timeout_sec",
        "tool_timeouts",
        "type",
        "url",
        "urlTemplate",
        "url_template",
    ];
    let unknown: Vec<&str> = object
        .keys()
        .map(String::as_str)
        .filter(|key| !SUPPORTED.contains(key))
        .collect();
    if unknown.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "包含不支持的字段：{}（请检查是否拼写错误）",
            unknown.join(", ")
        ))
    }
}

fn optional_json_string(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<Option<String>, String> {
    match object.get(key) {
        Some(value) => value
            .as_str()
            .map(|value| Some(value.to_string()))
            .ok_or_else(|| format!("'{key}' 必须是字符串")),
        None => Ok(None),
    }
}

fn json_string_map(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<HashMap<String, String>, String> {
    let Some(value) = object.get(key) else {
        return Ok(HashMap::new());
    };
    let map = value
        .as_object()
        .ok_or_else(|| format!("'{key}' 必须是对象"))?;
    map.iter()
        .map(|(name, value)| {
            value
                .as_str()
                .map(|value| (name.clone(), value.to_string()))
                .ok_or_else(|| format!("'{key}.{name}' 必须是字符串"))
        })
        .collect()
}

fn json_string_array(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<Vec<String>, String> {
    let Some(value) = object.get(key) else {
        return Ok(Vec::new());
    };
    let array = value
        .as_array()
        .ok_or_else(|| format!("'{key}' 必须是字符串数组"))?;
    array
        .iter()
        .enumerate()
        .map(|(index, value)| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| format!("'{key}[{index}]' 必须是字符串"))
        })
        .collect()
}

fn json_string_array_alias(
    object: &serde_json::Map<String, serde_json::Value>,
    camel: &str,
    snake: &str,
) -> Result<Vec<String>, String> {
    if object.contains_key(camel) {
        json_string_array(object, camel)
    } else {
        json_string_array(object, snake)
    }
}

fn json_u64_alias(
    object: &serde_json::Map<String, serde_json::Value>,
    camel: &str,
    snake: &str,
) -> Result<Option<u64>, String> {
    let (key, value) = if let Some(value) = object.get(camel) {
        (camel, value)
    } else if let Some(value) = object.get(snake) {
        (snake, value)
    } else {
        return Ok(None);
    };
    value
        .as_u64()
        .map(Some)
        .ok_or_else(|| format!("'{key}' 必须是正整数"))
}

fn json_typed<T: serde::de::DeserializeOwned>(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<Option<T>, String> {
    object
        .get(key)
        .cloned()
        .map(|value| serde_json::from_value(value).map_err(|e| format!("'{key}' 配置无效：{e}")))
        .transpose()
}

fn json_u64_map_alias(
    object: &serde_json::Map<String, serde_json::Value>,
    camel: &str,
    snake: &str,
) -> Result<HashMap<String, u64>, String> {
    let Some((key, value)) = object
        .get(camel)
        .map(|value| (camel, value))
        .or_else(|| object.get(snake).map(|value| (snake, value)))
    else {
        return Ok(HashMap::new());
    };
    serde_json::from_value(value.clone()).map_err(|e| format!("'{key}' 必须是整数映射：{e}"))
}

fn json_bool_alias(
    object: &serde_json::Map<String, serde_json::Value>,
    camel: &str,
    snake: &str,
) -> Result<Option<bool>, String> {
    let Some((key, value)) = object
        .get(camel)
        .map(|value| (camel, value))
        .or_else(|| object.get(snake).map(|value| (snake, value)))
    else {
        return Ok(None);
    };
    value
        .as_bool()
        .map(Some)
        .ok_or_else(|| format!("'{key}' 必须是布尔值"))
}

fn request_to_mirror_json(server: &McpUpsertRequest) -> serde_json::Value {
    let mut object = serde_json::Map::new();
    if server.transport == "stdio" {
        object.insert("command".into(), server.target.clone().into());
        if !server.args.is_empty() {
            object.insert("args".into(), serde_json::json!(server.args));
        }
        if !server.env.is_empty() {
            object.insert("env".into(), serde_json::json!(server.env));
        }
        if let Some(cwd) = &server.cwd {
            object.insert("cwd".into(), cwd.clone().into());
        }
    } else {
        object.insert("url".into(), server.target.clone().into());
        if server.transport == "sse" {
            object.insert("type".into(), "sse".into());
        } else {
            object.insert("type".into(), "streamable-http".into());
        }
        if !server.headers.is_empty() {
            object.insert("headers".into(), serde_json::json!(server.headers));
        }
        if let Some(value) = &server.bearer_token_env_var {
            object.insert("bearerTokenEnvVar".into(), value.clone().into());
        }
        if let Some(value) = &server.oauth_client_id {
            object.insert("oauthClientId".into(), value.clone().into());
        }
        if let Some(value) = &server.oauth_client_secret_env_var {
            object.insert("oauthClientSecretEnvVar".into(), value.clone().into());
        }
        if !server.oauth_scopes.is_empty() {
            object.insert("oauthScopes".into(), serde_json::json!(server.oauth_scopes));
        }
    }
    if let Some(enabled) = server.enabled {
        object.insert("enabled".into(), enabled.into());
    }
    if let Some(value) = server.startup_timeout_sec {
        object.insert("startupTimeoutSec".into(), value.into());
    }
    if let Some(value) = server.tool_timeout_sec {
        object.insert("toolTimeoutSec".into(), value.into());
    }
    if let Some(value) = &server.oauth {
        object.insert("oauth".into(), serde_json::json!(value));
    }
    if let Some(value) = &server.setup {
        object.insert("setup".into(), serde_json::json!(value));
    }
    if !server.tool_timeouts.is_empty() {
        object.insert(
            "toolTimeouts".into(),
            serde_json::json!(server.tool_timeouts),
        );
    }
    if let Some(value) = server.expose_image_base64 {
        object.insert("exposeImageBase64".into(), value.into());
    }
    serde_json::Value::Object(object)
}

fn read_mirror_servers() -> serde_json::Map<String, serde_json::Value> {
    let content = match std::fs::read_to_string(mcp_json_path()) {
        Ok(content) => content,
        Err(_) => return serde_json::Map::new(),
    };
    serde_json::from_str::<serde_json::Value>(&content)
        .ok()
        .and_then(|root| root.get("mcpServers").cloned())
        .and_then(|servers| servers.as_object().cloned())
        .unwrap_or_default()
}

fn write_mirror_servers(servers: serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    let content = serde_json::to_vec_pretty(&serde_json::json!({ "mcpServers": servers }))
        .map_err(|e| format!("序列化 mcp.json 失败：{e}"))?;
    crate::paths::write_private_file(&mcp_json_path(), &content)
}

fn mirror_single_server(server: &McpUpsertRequest, _preserve_runtime: bool) -> Result<(), String> {
    let mut servers = read_mirror_servers();
    let mut next = request_to_mirror_json(server);
    // Keep editor-only token prefill fields that are intentionally not valid
    // in the Runtime's HTTP schema.
    if let (Some(old), Some(next_obj)) = (servers.get(&server.name), next.as_object_mut()) {
        if let Some(old_env) = old.get("env") {
            next_obj.entry("env").or_insert_with(|| old_env.clone());
        }
    }
    servers.insert(server.name.clone(), next);
    write_mirror_servers(servers)
}

fn mirror_delete_server(name: &str) -> Result<(), String> {
    let mut servers = read_mirror_servers();
    servers.remove(name);
    write_mirror_servers(servers)
}

fn mirror_toggle_server(name: &str, enabled: bool) -> Result<(), String> {
    let mut servers = read_mirror_servers();
    if let Some(config) = servers
        .get_mut(name)
        .and_then(|value| value.as_object_mut())
    {
        config.insert("enabled".into(), enabled.into());
        write_mirror_servers(servers)?;
    }
    Ok(())
}

fn restore_config_snapshot(path: &std::path::Path, snapshot: Option<&[u8]>) -> Result<(), String> {
    if let Some(bytes) = snapshot {
        crate::paths::write_private_file(path, bytes)
    } else if path.exists() {
        // The operation created config.toml from scratch. Preserve unrelated
        // config safety by only removing it when it is now an empty TOML table.
        let empty = std::fs::read_to_string(path)
            .ok()
            .and_then(|content| toml::from_str::<toml::Value>(&content).ok())
            .and_then(|value| value.as_table().cloned())
            .is_some_and(|table| table.is_empty());
        if empty {
            std::fs::remove_file(path).map_err(|e| format!("回滚配置文件失败：{e}"))?;
        }
        Ok(())
    } else {
        Ok(())
    }
}

// ---------- MCP OAuth authorization (echo.agent/mcp/auth_*) ----------
//
// EchoAgent implements the full MCP OAuth flow itself (RFC 9728/8414 discovery,
// DCR, PKCE, system-browser redirect + loopback callback; tokens persist to
// `~/.echo-agent/mcp_credentials.json`). We only need to *trigger* it: the browser
// opens from inside the EchoAgent process, and the call resolves when the flow
// completes — mirroring echo-agent's "跳浏览器授权 + 轮询状态" UX.

/// Result of `echo.agent/mcp/auth_trigger`, surfaced to the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAuthTriggerResult {
    /// "authenticated" | "failed" | "setup_required".
    pub status: String,
    /// Failure detail from EchoAgent (present when status == "failed").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct McpAuthTriggerWire {
    status: String,
    #[serde(default)]
    error: Option<String>,
}

/// Kick off the browser OAuth flow for one server. Long-running: resolves
/// when the user finishes (or abandons) the browser flow. EchoAgent opens the
/// system browser itself (`webbrowser::open` in xai-grok-mcp).
#[tauri::command]
pub async fn mcp_auth_trigger(
    state: State<'_, AppState>,
    session_id: String,
    server_name: String,
) -> Result<McpAuthTriggerResult, String> {
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    let params = raw_params(&serde_json::json!({
        "session_id": session_id,
        "server_name": server_name,
    }));
    let wire: McpAuthTriggerWire = call_ext(&tx, "echo.agent/mcp/auth_trigger", params)
        .await
        .map_err(|e| e.to_string())?;
    Ok(McpAuthTriggerResult {
        status: wire.status,
        error: wire.error,
    })
}

/// One entry of `echo.agent/mcp/auth_status` — a server EchoAgent has flagged as
/// requiring authorization (status is currently always "needs_auth").
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAuthStatusEntry {
    /// EchoAgent's wire format is snake_case (`server_name`); the frontend gets
    /// camelCase (`serverName`). Accept both on decode.
    #[serde(alias = "server_name")]
    pub server_name: String,
    pub status: String,
}

#[derive(Debug, Deserialize)]
struct McpAuthStatusWire {
    #[serde(default)]
    servers: Vec<McpAuthStatusEntry>,
}

/// List servers that EchoAgent has marked `needs_auth` for this session.
#[tauri::command]
pub async fn mcp_auth_status(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<McpAuthStatusEntry>, String> {
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    let params = raw_params(&serde_json::json!({ "session_id": session_id }));
    let wire: McpAuthStatusWire = call_ext(&tx, "echo.agent/mcp/auth_status", params)
        .await
        .map_err(|e| e.to_string())?;
    Ok(wire.servers)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_list_wire_maps_transport_health_and_tools() {
        let response: McpListResponse = serde_json::from_value(serde_json::json!({
            "servers": [{
                "name": "filesystem",
                "source": "local",
                "type": "stdio",
                "command": "npx",
                "args": ["-y", "server-filesystem"],
                "env": [{ "name": "ROOT", "value": "/tmp" }],
                "setup": {
                    "fields": [{
                        "id": "region",
                        "label": "Region",
                        "type": "select",
                        "required": true,
                        "options": [{ "label": "US", "value": "us" }]
                    }],
                    "variables": {}
                },
                "setupValues": { "region": "us" },
                "session": {
                    "enabled": true,
                    "status": "ready",
                    "tools": [{
                        "name": "filesystem__read_file",
                        "displayName": "read_file",
                        "description": "Read one file",
                        "enabled": true
                    }],
                    "authRequired": false,
                    "setupRequired": false
                }
            }]
        }))
        .unwrap();
        let entry = map_wire_entry(response.into_servers().remove(0));
        assert_eq!(entry.transport.as_deref(), Some("stdio"));
        assert_eq!(entry.target.as_deref(), Some("npx"));
        assert_eq!(entry.status.as_deref(), Some("ready"));
        assert!(entry.enabled);
        assert!(entry.live);
        assert_eq!(entry.tools.len(), 1);
        assert_eq!(entry.env.get("ROOT").map(String::as_str), Some("/tmp"));
        assert_eq!(entry.setup.as_ref().unwrap().fields[0].id, "region");
        assert_eq!(
            entry.setup_values.get("region").map(String::as_str),
            Some("us")
        );
    }

    #[test]
    fn mcp_json_parser_preserves_advanced_http_options() {
        let request = json_to_upsert(
            "linear",
            &serde_json::json!({
                "url": "https://mcp.example.test/mcp",
                "type": "streamable-http",
                "headers": { "X-Tenant": "demo" },
                "bearerTokenEnvVar": "LINEAR_TOKEN",
                "oauthClientId": "desktop",
                "oauthScopes": ["read", "write"],
                "startupTimeoutSec": 20,
                "toolTimeoutSec": 90,
                "oauth": {
                    "clientId": "nested-client",
                    "scopes": ["offline_access"],
                    "callbackPort": 34567
                },
                "toolTimeouts": { "search": 120 },
                "exposeImageBase64": true
            }),
        )
        .unwrap();
        assert_eq!(request.transport, "streamable_http");
        assert_eq!(
            request.bearer_token_env_var.as_deref(),
            Some("LINEAR_TOKEN")
        );
        assert_eq!(request.oauth_scopes, vec!["read", "write"]);
        assert_eq!(request.tool_timeout_sec, Some(90));
        assert_eq!(request.tool_timeouts.get("search"), Some(&120));
        assert_eq!(
            request.oauth.as_ref().and_then(|oauth| oauth.callback_port),
            Some(34567)
        );
        assert_eq!(request.expose_image_base64, Some(true));
        let roundtrip = request_to_mirror_json(&request);
        assert_eq!(roundtrip["toolTimeouts"]["search"], 120);
        assert_eq!(roundtrip["oauth"]["clientId"], "nested-client");
        validate_upsert_request(&request).unwrap();
    }

    #[test]
    fn validation_rejects_insecure_remote_http_but_allows_loopback() {
        let mut request = McpUpsertRequest {
            name: "demo".into(),
            transport: "streamable_http".into(),
            target: "http://example.test/mcp".into(),
            args: Vec::new(),
            env: HashMap::new(),
            headers: HashMap::new(),
            enabled: Some(true),
            cwd: None,
            bearer_token_env_var: None,
            oauth_client_id: None,
            oauth_client_secret_env_var: None,
            oauth_scopes: Vec::new(),
            startup_timeout_sec: None,
            tool_timeout_sec: None,
            oauth: None,
            setup: None,
            tool_timeouts: HashMap::new(),
            expose_image_base64: None,
        };
        assert!(validate_upsert_request(&request)
            .unwrap_err()
            .contains("HTTPS"));
        request.target = "http://127.0.0.1:3000/mcp".into();
        validate_upsert_request(&request).unwrap();
    }
}
