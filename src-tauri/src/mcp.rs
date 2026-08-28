//! Connectors panel — drives EchoAgent's `x.ai/mcp/*` extension methods.
//!
//! MCP server configs live in `~/.echo-agent/config.toml` as `[mcp_servers.<name>]`
//! tables (see `xai-grok-config-types/src/mcp.rs` for the full schema). EchoAgent
//! owns the canonical state and exposes full CRUD over ACP, so we go through
//! `x.ai/mcp/list|upsert|delete|toggle` rather than editing the TOML directly
//! — EchoAgent will validate, start/stop the server, and broadcast status updates
//! via `x.ai/mcp/server_status` (which bridge.rs forwards as `agent://mcp-status`).

use std::collections::HashMap;
use std::path::PathBuf;

use agent_client_protocol as acp;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::AppState;
use crate::ext::{call_ext, call_ext_value, raw_params};

/// One MCP server entry surfaced to the UI. Mirrors the fields of EchoAgent's
/// `McpServerEntry` (`xai-grok-shell/src/inspect/mod.rs:227`) plus the live
/// status that arrives via `x.ai/mcp/server_status` notifications.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerEntry {
    pub name: String,
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
}

/// The list endpoint returns either a bare array or `{ servers: [...] }`,
/// depending on the EchoAgent build. Accept both.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum McpListResponse {
    Array(Vec<McpServerEntry>),
    Wrapped {
        #[serde(default)]
        servers: Vec<McpServerEntry>,
    },
}

impl McpListResponse {
    fn into_servers(self) -> Vec<McpServerEntry> {
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
}

/// List configured MCP servers. `session_id` is optional — EchoAgent's
/// `McpListRequest` accepts it (camelCase `sessionId`) to enrich entries with
/// live session state; without it the agent-level catalog is returned.
#[tauri::command]
pub async fn mcp_list(
    state: State<'_, AppState>,
    session_id: Option<String>,
) -> Result<Vec<McpServerEntry>, String> {
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    let params = raw_params(&serde_json::json!({ "sessionId": session_id }));
    let v: McpListResponse = call_ext(&tx, "x.ai/mcp/list", params)
        .await
        .map_err(|e| e.to_string())?;
    Ok(v.into_servers())
}

/// Add or update an MCP server. Translates the frontend payload into the
/// `[mcp_servers.<name>]` shape EchoAgent expects (see McpServerTransportConfig).
#[tauri::command]
pub async fn mcp_upsert(
    state: State<'_, AppState>,
    session_id: String,
    server: McpUpsertRequest,
) -> Result<(), String> {
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    let payload = build_upsert_payload(&session_id, &server)?;
    let params = raw_params(&payload);
    let _: acp::ExtResponse = call_ext_value(&tx, "x.ai/mcp/upsert", params)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Delete an MCP server by name.
#[tauri::command]
pub async fn mcp_delete(
    state: State<'_, AppState>,
    session_id: String,
    name: String,
) -> Result<(), String> {
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    let params = raw_params(&serde_json::json!({
        "session_id": session_id,
        "server_name": name,
    }));
    let _: acp::ExtResponse = call_ext_value(&tx, "x.ai/mcp/delete", params)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Enable or disable an MCP server at runtime (no restart needed).
#[tauri::command]
pub async fn mcp_toggle(
    state: State<'_, AppState>,
    session_id: String,
    name: String,
    enabled: bool,
) -> Result<(), String> {
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    let params = raw_params(&serde_json::json!({
        "session_id": session_id,
        "server_name": name,
        "enabled": enabled,
    }));
    let _: acp::ExtResponse = call_ext_value(&tx, "x.ai/mcp/toggle", params)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Translate the frontend payload to the JSON EchoAgent's `x.ai/mcp/upsert` expects.
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
    Ok(serde_json::Value::Object(payload))
}

// ---------- standalone mcp.json editor (截图 6 / 7) ----------
//
// WorkBuddy's "MCP 服务管理" modal edits a raw `mcp.json` file (`{ "mcpServers":
// { ... } }`) in a Monaco-style editor. EchoAgent itself stores MCP config in
// `config.toml`, so we keep a *parallel* `~/.echo-agent/mcp.json` as the editor's
// source of truth and, on save, best-effort mirror each server into EchoAgent over
// ACP so the entries actually connect. The file path is returned to the UI so
// the "配置文件路径" line matches reality.

/// Default content shown when the file does not exist yet.
const EMPTY_MCP_JSON: &str = "{\n  \"mcpServers\": {}\n}";

/// Raw `mcp.json` payload returned to the editor.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigFile {
    pub file_path: String,
    pub content: String,
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
    let content = match std::fs::read_to_string(&path) {
        Ok(s) if !s.trim().is_empty() => s,
        Ok(_) => EMPTY_MCP_JSON.to_string(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => EMPTY_MCP_JSON.to_string(),
        Err(e) => return Err(format!("读取 mcp.json 失败：{e}")),
    };
    Ok(McpConfigFile {
        file_path: path.to_string_lossy().into_owned(),
        content,
    })
}

/// Validate + write the config file, then best-effort mirror each server into
/// EchoAgent so the saved entries connect. Validation failure (invalid JSON / not an
/// object) aborts *before* writing. Sync failures are logged, not fatal — the
/// file is the editor's source of truth. `session_id` is required for the live
/// sync (EchoAgent's upsert is session-scoped); without it we only write the file.
#[tauri::command]
pub async fn mcp_config_save(
    state: State<'_, AppState>,
    content: String,
    session_id: Option<String>,
) -> Result<(), String> {
    let trimmed = content.trim();
    let parsed: serde_json::Value = if trimmed.is_empty() {
        serde_json::from_str(EMPTY_MCP_JSON).unwrap()
    } else {
        serde_json::from_str(trimmed).map_err(|e| format!("无效的 JSON：{e}"))?
    };
    if !parsed.is_object() {
        return Err("配置文件顶层必须是 JSON 对象".into());
    }
    if let Some(servers) = parsed.get("mcpServers") {
        if !servers.is_object() {
            return Err("\"mcpServers\" 必须是 JSON 对象".into());
        }
    }

    let path = mcp_json_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败：{e}"))?;
    }
    // Atomic-ish write via a sibling temp file + rename.
    let tmp = path.with_extension("json.tmp");
    let bytes = if trimmed.is_empty() {
        EMPTY_MCP_JSON.as_bytes().to_vec()
    } else {
        content.into_bytes()
    };
    std::fs::write(&tmp, &bytes).map_err(|e| format!("写入 mcp.json 失败：{e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("保存 mcp.json 失败：{e}")
    })?;

    // Best-effort sync into EchoAgent (only if the agent is up and we have a live
    // session — EchoAgent's `x.ai/mcp/upsert` is session-scoped). Failures are
    // non-fatal: the file is saved either way and the list view can still
    // toggle/delete individual servers. The lock guard is dropped *before* the
    // await (clone into a local first) so the returned future stays `Send`.
    let tx_opt = state.tx.lock().unwrap().clone();
    if let (Some(tx), Some(sid)) = (tx_opt, session_id.filter(|s| !s.is_empty())) {
        if let Some(map) = parsed.get("mcpServers").and_then(|v| v.as_object()) {
            for (name, cfg) in map {
                match json_to_upsert(name, cfg) {
                    Ok(server) => {
                        let payload = match build_upsert_payload(&sid, &server) {
                            Ok(p) => p,
                            Err(e) => {
                                eprintln!("[mcp_config_save] build '{name}' failed: {e}");
                                continue;
                            }
                        };
                        let params = raw_params(&payload);
                        let synced: Result<acp::ExtResponse, _> =
                            call_ext_value(&tx, "x.ai/mcp/upsert", params).await;
                        if let Err(e) = synced {
                            eprintln!("[mcp_config_save] sync '{name}' failed: {e}");
                        }
                    }
                    Err(e) => eprintln!("[mcp_config_save] skip '{name}': {e}"),
                }
            }
        }
    }
    Ok(())
}

/// Map one standard `mcpServers.<name>` value (the shape editors like WorkBuddy
/// / Claude Desktop use) onto our `McpUpsertRequest` so we can reuse the EchoAgent
/// upsert path. Recognizes stdio (`command`) and http/sse (`url`) entries.
fn json_to_upsert(name: &str, cfg: &serde_json::Value) -> Result<McpUpsertRequest, String> {
    let obj = cfg
        .as_object()
        .ok_or_else(|| "server 配置必须是对象".to_string())?;
    let get_str = |k: &str| obj.get(k).and_then(|v| v.as_str()).map(str::to_string);
    let enabled = obj.get("enabled").and_then(|v| v.as_bool());
    if let Some(url) = get_str("url") {
        let transport = match obj.get("type").and_then(|v| v.as_str()) {
            Some("sse") => "sse".to_string(),
            Some("streamable-http") | Some("streamable_http") | Some("streamableHttp") => {
                "streamable_http".to_string()
            }
            _ => "http".to_string(),
        };
        // WorkBuddy connector manifests use `staticHeaders` (e.g. kdocs);
        // standard mcp.json uses `headers`. Merge both, `headers` winning.
        let mut headers = obj
            .get("staticHeaders")
            .and_then(|v| v.as_object())
            .map(|m| {
                m.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default();
        if let Some(m) = obj.get("headers").and_then(|v| v.as_object()) {
            for (k, v) in m {
                if let Some(s) = v.as_str() {
                    headers.insert(k.clone(), s.to_string());
                }
            }
        }
        Ok(McpUpsertRequest {
            name: name.to_string(),
            transport,
            target: url,
            args: Vec::new(),
            env: HashMap::new(),
            headers,
            enabled,
        })
    } else if let Some(command) = get_str("command") {
        let args = obj
            .get("args")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let env = obj
            .get("env")
            .and_then(|v| v.as_object())
            .map(|m| {
                m.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default();
        Ok(McpUpsertRequest {
            name: name.to_string(),
            transport: "stdio".to_string(),
            target: command,
            args,
            env,
            headers: HashMap::new(),
            enabled,
        })
    } else {
        Err("缺少 'command' 或 'url' 字段".to_string())
    }
}

// ---------- MCP OAuth authorization (x.ai/mcp/auth_*) ----------
//
// EchoAgent implements the full MCP OAuth flow itself (RFC 9728/8414 discovery,
// DCR, PKCE, system-browser redirect + loopback callback; tokens persist to
// `~/.echo-agent/mcp_credentials.json`). We only need to *trigger* it: the browser
// opens from inside the EchoAgent process, and the call resolves when the flow
// completes — mirroring workbuddy's "跳浏览器授权 + 轮询状态" UX.

/// Result of `x.ai/mcp/auth_trigger`, surfaced to the UI.
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
    let wire: McpAuthTriggerWire = call_ext(&tx, "x.ai/mcp/auth_trigger", params)
        .await
        .map_err(|e| e.to_string())?;
    Ok(McpAuthTriggerResult {
        status: wire.status,
        error: wire.error,
    })
}

/// One entry of `x.ai/mcp/auth_status` — a server EchoAgent has flagged as
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
    let wire: McpAuthStatusWire = call_ext(&tx, "x.ai/mcp/auth_status", params)
        .await
        .map_err(|e| e.to_string())?;
    Ok(wire.servers)
}
