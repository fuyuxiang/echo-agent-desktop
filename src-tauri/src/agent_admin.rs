//! Higher-level EchoAgent admin extensions — bridges the upstream `echo.agent/*` methods that
//! drive EchoAgent-equivalent features:
//!
//! - **Memory** (资料库): read/rewrite `~/.echo-agent/memory/MEMORY.md` + per-cwd
//!   workspace memory. `echo.agent/memory/{flush,rewrite}` + `compact_conversation`.
//! - **Session search** (历史检索): `echo.agent/session/search` over EchoAgent's FTS5.
//! - **Rewind** (回溯): `echo.agent/rewind/{execute,points}`.
//! - **Prompt history** (命令面板): `echo.agent/prompt_history`.
//! - **Slash commands** ("/ 调用技能与指令"): `echo.agent/commands/list`.
//! - **Session fork/info/close**: `echo.agent/session/{fork,info,close}`.
//! - **Plan mode toggle**: `echo.agent/toggle_plan_mode` (notification both ways).
//! - **Folder trust**: `echo.agent/folder_trust/request` responses.
//! - **Subagent / task observation**: `echo.agent/{subagent,task}/*`.
//!
//! All ACP calls go through `ext::call_ext` / `call_ext_value`. File-backed
//! reads (memory markdown) go through direct fs (EchoAgent doesn't expose list).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::AppState;
use crate::ext::{call_ext, raw_params};

// ========================================================================
// Memory (资料库)
// ========================================================================

/// One memory note. EchoAgent stores memories as markdown chunks; we surface the
/// raw text plus which scope it came from.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    /// "global" (~/.echo-agent/memory/) or "workspace" (<cwd>/.echo-agent/memory/).
    pub scope: String,
    /// Relative path under the memory root (e.g. "MEMORY.md" or "facts/rust.md").
    pub path: String,
    /// Raw markdown contents.
    pub content: String,
    /// Byte size (for display).
    pub size: u64,
}

fn global_memory_dir() -> PathBuf {
    crate::paths::echo_agent_home_dir().join("memory")
}

fn workspace_memory_dir(cwd: &str) -> PathBuf {
    PathBuf::from(cwd).join(".echo-agent").join("memory")
}

/// Recursively scan a memory dir for `*.md` files. Best-effort.
fn scan_memory_dir(dir: &std::path::Path, scope: &str) -> Vec<MemoryEntry> {
    let mut out = Vec::new();
    let Ok(stack_root) = dir.canonicalize() else {
        return out;
    };
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Ok(rel) = path.strip_prefix(&stack_root) else {
                continue;
            };
            let size = content.len() as u64;
            out.push(MemoryEntry {
                scope: scope.to_string(),
                path: rel.to_string_lossy().replace('\\', "/"),
                content,
                size,
            });
        }
    }
    // Stable order: global MEMORY.md first, then alphabetical.
    out.sort_by(|a, b| {
        let ag = a.path == "MEMORY.md";
        let bg = b.path == "MEMORY.md";
        bg.cmp(&ag).then_with(|| a.path.cmp(&b.path))
    });
    out
}

/// List memory notes from both global (`~/.echo-agent/memory/`) and the current
/// workspace (`<cwd>/.echo-agent/memory/`). EchoAgent auto-writes these as it learns
/// facts across sessions.
#[tauri::command]
pub fn memory_list(cwd: Option<String>) -> Vec<MemoryEntry> {
    let mut out = scan_memory_dir(&global_memory_dir(), "global");
    if let Some(cwd) = cwd {
        let ws_dir = workspace_memory_dir(&cwd);
        if ws_dir.exists() {
            out.extend(scan_memory_dir(&ws_dir, "workspace"));
        }
    }
    out
}

/// Read a single memory file. `scope` selects the root; `path` is relative.
#[tauri::command]
pub fn memory_get(scope: String, path: String, cwd: Option<String>) -> Result<String, String> {
    let root = match scope.as_str() {
        "workspace" => {
            workspace_memory_dir(cwd.as_deref().ok_or("cwd required for workspace scope")?)
        }
        _ => global_memory_dir(),
    };
    // Prevent path traversal: reject absolute paths and `..`.
    if path.starts_with('/') || path.starts_with('\\') || path.contains("..") {
        return Err("invalid memory path".into());
    }
    let full = root.join(&path);
    std::fs::read_to_string(&full).map_err(|e| format!("read {}: {e}", full.display()))
}

/// Create or overwrite a memory note. Writes to the selected scope's root.
#[tauri::command]
pub fn memory_save(
    scope: String,
    path: String,
    content: String,
    cwd: Option<String>,
) -> Result<MemoryEntry, String> {
    let root = match scope.as_str() {
        "workspace" => {
            workspace_memory_dir(cwd.as_deref().ok_or("cwd required for workspace scope")?)
        }
        _ => global_memory_dir(),
    };
    if path.starts_with('/') || path.starts_with('\\') || path.contains("..") {
        return Err("invalid memory path".into());
    }
    let full = root.join(&path);
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create dir: {e}"))?;
    }
    let size = content.len() as u64;
    std::fs::write(&full, &content).map_err(|e| format!("write: {e}"))?;
    Ok(MemoryEntry {
        scope,
        path,
        content,
        size,
    })
}

/// Delete a memory note.
#[tauri::command]
pub fn memory_delete(scope: String, path: String, cwd: Option<String>) -> Result<(), String> {
    let root = match scope.as_str() {
        "workspace" => {
            workspace_memory_dir(cwd.as_deref().ok_or("cwd required for workspace scope")?)
        }
        _ => global_memory_dir(),
    };
    if path.starts_with('/') || path.starts_with('\\') || path.contains("..") {
        return Err("invalid memory path".into());
    }
    let full = root.join(&path);
    std::fs::remove_file(&full).map_err(|e| format!("delete: {e}"))
}

/// Trigger EchoAgent to rewrite memories into structured markdown via an LLM pass.
/// Maps to `echo.agent/memory/rewrite`. Optional — the user can also just edit the
/// raw MEMORY.md themselves.
#[tauri::command]
pub async fn memory_rewrite(state: State<'_, AppState>) -> Result<(), String> {
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    let params = raw_params(&serde_json::json!({}));
    let _: serde_json::Value = call_ext(&tx, "echo.agent/memory/rewrite", params)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Flush in-flight memory writes to disk (`echo.agent/memory/flush`).
#[tauri::command]
pub async fn memory_flush(state: State<'_, AppState>) -> Result<(), String> {
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    let params = raw_params(&serde_json::json!({}));
    let _: serde_json::Value = call_ext(&tx, "echo.agent/memory/flush", params)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ========================================================================
// Session search (FTS5)
// ========================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub session_id: String,
    pub cwd: Option<String>,
    pub title: Option<String>,
    /// Snippet of matched content (FTS5 highlights).
    pub snippet: Option<String>,
    /// Match rank (lower = better).
    pub rank: Option<f64>,
    pub updated_at: Option<String>,
}

/// `echo.agent/session/search` response shape (defensive — varies by EchoAgent version).
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum SearchResponse {
    Results {
        #[serde(default, alias = "results")]
        results: Vec<RawSearchHit>,
    },
    Hits(Vec<RawSearchHit>),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSearchHit {
    session_id: String,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    snippet: Option<String>,
    #[serde(default)]
    rank: Option<f64>,
    #[serde(default)]
    updated_at: Option<String>,
}

/// Full-text search across all sessions (EchoAgent's SQLite FTS5 index).
/// `cwd` optionally narrows to one workspace.
#[tauri::command]
pub async fn session_search(
    state: State<'_, AppState>,
    query: String,
    cwd: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<SearchHit>, String> {
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    let payload = serde_json::json!({
        "query": query,
        "cwd": cwd,
        "limit": limit.unwrap_or(50),
        "offset": 0,
        "includeContent": true,
    });
    let params = raw_params(&payload);
    let resp: SearchResponse = call_ext(&tx, "echo.agent/session/search", params)
        .await
        .map_err(|e| e.to_string())?;
    let raw = match resp {
        SearchResponse::Results { results } => results,
        SearchResponse::Hits(v) => v,
    };
    Ok(raw
        .into_iter()
        .map(|h| SearchHit {
            session_id: h.session_id,
            cwd: h.cwd,
            title: h.title,
            snippet: h.snippet,
            rank: h.rank,
            updated_at: h.updated_at,
        })
        .collect())
}

// ========================================================================
// Rewind (回溯到指定 prompt 索引)
// ========================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewindPoint {
    pub prompt_index: u32,
    pub prompt_preview: Option<String>,
    pub timestamp: Option<String>,
    /// First assistant response snippet (for timeline display).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_preview: Option<String>,
    /// Whether this prompt produced file changes (for badge display).
    #[serde(default)]
    pub has_file_changes: bool,
    /// Whether this prompt produced memory writes (for badge display).
    #[serde(default)]
    pub has_memory_changes: bool,
    /// Tool calls made during this turn (for timeline detail).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_names: Option<Vec<String>>,
}

/// List the prompts a session can rewind to.
#[tauri::command]
pub async fn rewind_points(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<RewindPoint>, String> {
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    let params = raw_params(&serde_json::json!({ "sessionId": session_id }));
    let v: serde_json::Value = call_ext(&tx, "echo.agent/rewind/points", params)
        .await
        .map_err(|e| e.to_string())?;
    // Response shape: array or { points: [...] }.
    let arr = v
        .get("points")
        .and_then(|p| p.as_array())
        .or_else(|| v.as_array());
    let Some(arr) = arr else {
        return Ok(Vec::new());
    };
    Ok(arr
        .iter()
        .map(|item| {
            serde_json::from_value::<RewindPoint>(item.clone()).unwrap_or_else(|_| {
                let prompt_index = item
                    .get("promptIndex")
                    .or_else(|| item.get("prompt_index"))
                    .and_then(|n| n.as_u64())
                    .unwrap_or(0) as u32;
                let prompt_preview = item
                    .get("promptPreview")
                    .or_else(|| item.get("prompt_preview"))
                    .and_then(|s| s.as_str())
                    .map(String::from);
                let timestamp = item
                    .get("timestamp")
                    .and_then(|s| s.as_str())
                    .map(String::from);
                let message_preview = item
                    .get("messagePreview")
                    .or_else(|| item.get("message_preview"))
                    .and_then(|s| s.as_str())
                    .map(String::from);
                let has_file_changes = item
                    .get("hasFileChanges")
                    .or_else(|| item.get("has_file_changes"))
                    .and_then(|b| b.as_bool())
                    .unwrap_or(false);
                let has_memory_changes = item
                    .get("hasMemoryChanges")
                    .or_else(|| item.get("has_memory_changes"))
                    .and_then(|b| b.as_bool())
                    .unwrap_or(false);
                let tool_names = item
                    .get("toolNames")
                    .or_else(|| item.get("tool_names"))
                    .and_then(|a| a.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect()
                    });
                RewindPoint {
                    prompt_index,
                    prompt_preview,
                    timestamp,
                    message_preview,
                    has_file_changes,
                    has_memory_changes,
                    tool_names,
                }
            })
        })
        .collect())
}

/// Rewind a session to a specific prompt index. `mode` ∈ "all" (default) |
/// "conversation" (don't touch files) | "files".
#[tauri::command]
pub async fn rewind_execute(
    state: State<'_, AppState>,
    session_id: String,
    target_prompt_index: u32,
    mode: Option<String>,
    force: Option<bool>,
) -> Result<(), String> {
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    let payload = serde_json::json!({
        "sessionId": session_id,
        "targetPromptIndex": target_prompt_index,
        "mode": mode.unwrap_or_else(|| "all".into()),
        "force": force.unwrap_or(false),
    });
    let params = raw_params(&payload);
    let _: serde_json::Value = call_ext(&tx, "echo.agent/rewind/execute", params)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ========================================================================
// Session fork / info
// ========================================================================

/// Fork a session: copy its history to a new session id so the user can
/// explore a different direction. Returns the new session id.
#[tauri::command]
pub async fn session_fork(
    state: State<'_, AppState>,
    session_id: String,
    cwd: Option<String>,
) -> Result<String, String> {
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    let params = raw_params(&serde_json::json!({ "sessionId": session_id, "cwd": cwd }));
    let v: serde_json::Value = call_ext(&tx, "echo.agent/session/fork", params)
        .await
        .map_err(|e| e.to_string())?;
    // Response: { sessionId: "..." } or bare string.
    if let Some(id) = v.get("sessionId").and_then(|s| s.as_str()) {
        return Ok(id.to_string());
    }
    if let Some(id) = v.as_str() {
        return Ok(id.to_string());
    }
    Err("fork response missing sessionId".into())
}

// ========================================================================
// Slash commands + prompt history
// ========================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommand {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub argument_hint: Option<String>,
    /// Source: "builtin" | "skill" | "plugin".
    #[serde(default)]
    pub source: Option<String>,
}

/// List slash commands EchoAgent knows (builtin + skills + plugins). Powers the
/// Composer's "/" autocomplete.
#[tauri::command]
pub async fn commands_list(
    state: State<'_, AppState>,
    session_id: Option<String>,
    cwd: Option<String>,
) -> Result<Vec<SlashCommand>, String> {
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    let params = raw_params(&serde_json::json!({
        "sessionId": session_id,
        "cwd": cwd,
    }));
    let v: serde_json::Value = call_ext(&tx, "echo.agent/commands/list", params)
        .await
        .map_err(|e| e.to_string())?;
    Ok(parse_slash_commands(&v))
}

fn parse_slash_commands(v: &serde_json::Value) -> Vec<SlashCommand> {
    let arr = v
        .get("commands")
        .and_then(|c| c.as_array())
        .or_else(|| v.as_array());
    let Some(arr) = arr else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|item| {
            let meta = item.get("_meta");
            let source = meta
                .and_then(|m| m.get("pluginName"))
                .and_then(|s| s.as_str())
                .map(|name| format!("plugin:{name}"))
                .or_else(|| {
                    meta.and_then(|m| m.get("scope"))
                        .and_then(|s| s.as_str())
                        .map(|scope| format!("skill:{scope}"))
                })
                .or_else(|| {
                    meta.and_then(|m| m.get("workflowSource"))
                        .and_then(|s| s.as_str())
                        .map(|source| format!("workflow:{source}"))
                })
                .unwrap_or_else(|| "builtin".to_string());
            Some(SlashCommand {
                name: item.get("name")?.as_str()?.to_string(),
                description: item
                    .get("description")
                    .and_then(|s| s.as_str())
                    .map(String::from),
                argument_hint: item
                    .get("input")
                    .and_then(|input| input.get("hint"))
                    .or_else(|| item.get("argumentHint"))
                    .or_else(|| item.get("argument_hint"))
                    .and_then(|s| s.as_str())
                    .map(String::from),
                source: Some(source),
            })
        })
        .collect()
}

/// Cross-session prompt history (for the Composer's ↑ history dropdown and
/// the command palette).
#[tauri::command]
pub async fn prompt_history(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<String>, String> {
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    let payload = serde_json::json!({ "limit": limit.unwrap_or(100) });
    let params = raw_params(&payload);
    let v: serde_json::Value = call_ext(&tx, "echo.agent/prompt_history", params)
        .await
        .map_err(|e| e.to_string())?;
    // Response: array of strings or { prompts: [...] } or { history: [...] }.
    let arr = v
        .get("prompts")
        .or_else(|| v.get("history"))
        .and_then(|x| x.as_array())
        .or_else(|| v.as_array());
    let Some(arr) = arr else {
        return Ok(Vec::new());
    };
    Ok(arr
        .iter()
        .filter_map(|item| {
            item.as_str()
                .map(String::from)
                .or_else(|| item.get("text").and_then(|s| s.as_str()).map(String::from))
        })
        .collect())
}

// ========================================================================
// Subagent / background task observation
// ========================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningTask {
    pub id: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
}

/// List running background tasks / subagents. Powers a "running tasks" panel.
#[tauri::command]
pub async fn tasks_list(state: State<'_, AppState>) -> Result<Vec<RunningTask>, String> {
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    let params = raw_params(&serde_json::json!({}));
    // Try task/list first; some EchoAgent builds only expose subagent/list_running.
    let v: serde_json::Value = match call_ext(&tx, "echo.agent/task/list", params.clone()).await {
        Ok(v) => v,
        Err(_) => call_ext(&tx, "echo.agent/subagent/list_running", params)
            .await
            .map_err(|e| e.to_string())?,
    };
    let arr = v
        .get("tasks")
        .or_else(|| v.get("subagents"))
        .and_then(|x| x.as_array())
        .or_else(|| v.as_array());
    let Some(arr) = arr else {
        return Ok(Vec::new());
    };
    Ok(arr
        .iter()
        .filter_map(|item| {
            Some(RunningTask {
                id: item
                    .get("id")
                    .or_else(|| item.get("taskId"))
                    .or_else(|| item.get("subagentId"))
                    .and_then(|s| s.as_str())?
                    .to_string(),
                kind: item.get("kind").and_then(|s| s.as_str()).map(String::from),
                description: item
                    .get("description")
                    .and_then(|s| s.as_str())
                    .map(String::from),
                status: item
                    .get("status")
                    .and_then(|s| s.as_str())
                    .map(String::from),
                session_id: item
                    .get("sessionId")
                    .and_then(|s| s.as_str())
                    .map(String::from),
            })
        })
        .collect())
}

/// Kill a running background task or subagent.
#[tauri::command]
pub async fn task_kill(state: State<'_, AppState>, task_id: String) -> Result<(), String> {
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    let params = raw_params(&serde_json::json!({ "taskId": task_id }));
    // Prefer task/kill, fall back to subagent/cancel.
    if call_ext::<serde_json::Value>(&tx, "echo.agent/task/kill", params.clone())
        .await
        .is_ok()
    {
        return Ok(());
    }
    let subagent_params = raw_params(&serde_json::json!({ "subagentId": task_id }));
    let _: serde_json::Value = call_ext(&tx, "echo.agent/subagent/cancel", subagent_params)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ========================================================================
// Folder trust
// ========================================================================

/// When EchoAgent sends `echo.agent/folder_trust/request`, the frontend shows a dialog.
/// The user's decision is sent back via this command, which calls the EchoAgent
/// ext method `echo.agent/folder_trust/respond` (or the ACP-standard permission
/// resolution path). The request itself is registered by bridge.rs.
#[tauri::command]
pub async fn folder_trust_respond(
    state: State<'_, AppState>,
    cwd: String,
    trusted: bool,
) -> Result<(), String> {
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    let payload = serde_json::json!({ "cwd": cwd, "trusted": trusted });
    let params = raw_params(&payload);
    // Best-effort: method name varies; if folder_trust/respond isn't registered,
    // the call returns MethodNotFound which we swallow (the agent will re-ask).
    let _: serde_json::Value = match call_ext(&tx, "echo.agent/folder_trust/respond", params).await
    {
        Ok(v) => v,
        Err(_) => return Ok(()),
    };
    Ok(())
}

// ========================================================================
// Plan mode
// ========================================================================

/// Toggle plan mode for the current session. In plan mode EchoAgent plans but
/// doesn't execute tools until the user approves. Maps to the
/// `echo.agent/toggle_plan_mode` notification (sent client→agent).
#[tauri::command]
pub async fn toggle_plan_mode(
    state: State<'_, AppState>,
    session_id: String,
    enabled: bool,
) -> Result<(), String> {
    use xai_acp_lib::{AcpAgentMessage, AcpArgs};
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    let notif = acp_ext_notification(
        "echo.agent/toggle_plan_mode",
        serde_json::json!({ "sessionId": session_id, "enabled": enabled }),
    );
    let (response_tx, _response_rx) = tokio::sync::oneshot::channel();
    let msg = AcpAgentMessage::ExtNotification(AcpArgs {
        request: notif,
        response_tx,
    });
    tx.send(msg)
        .map_err(|e| format!("send toggle_plan_mode: {e}"))?;
    Ok(())
}

/// Build an `acp::ExtNotification` with the given method + JSON params.
/// Notifications have no response (the oneshot is a throwaway).
fn acp_ext_notification(
    method: &str,
    payload: serde_json::Value,
) -> agent_client_protocol::ExtNotification {
    let raw = serde_json::value::to_raw_value(&payload)
        .unwrap_or_else(|_| serde_json::value::to_raw_value(&serde_json::Value::Null).unwrap());
    agent_client_protocol::ExtNotification::new(method, raw.into())
}

// ========================================================================
// Internal reload (hot-reload config after edits)
// ========================================================================

/// Hot-reload EchoAgent's view of MCP servers / skills / models / config without
/// restarting the app. Maps to `echo.agent/internal/reload_*` notifications.
/// `kind` ∈ "mcp_all" | "mcp_project" | "skills" | "models".
#[tauri::command]
pub async fn internal_reload(state: State<'_, AppState>, kind: String) -> Result<(), String> {
    use xai_acp_lib::{AcpAgentMessage, AcpArgs};
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    let method = match kind.as_str() {
        "mcp_all" => "echo.agent/internal/reload_all_mcp_servers",
        "mcp_project" => "echo.agent/internal/reload_project_mcp_servers",
        "skills" => "echo.agent/internal/reload_skills",
        "models" => "echo.agent/internal/reload_models",
        other => return Err(format!("unknown reload kind: {other}")),
    };
    let notif = acp_ext_notification(method, serde_json::json!({}));
    let (response_tx, _response_rx) = tokio::sync::oneshot::channel();
    let msg = AcpAgentMessage::ExtNotification(AcpArgs {
        request: notif,
        response_tx,
    });
    tx.send(msg).map_err(|e| format!("send reload: {e}"))?;
    Ok(())
}

// ========================================================================
// Plugins + Marketplace (echo.agent/plugins/*, echo.agent/marketplace/*)
// ========================================================================

/// List installed plugins via `echo.agent/plugins/list`. `session_id` is optional —
/// EchoAgent answers from the session's registry when given, otherwise from the
/// shared snapshot. Returns the raw `PluginsListResponse` JSON so the frontend
/// can render the full shape (skill/agent/hook/mcp counts etc.).
#[tauri::command]
pub async fn plugins_list(
    state: State<'_, AppState>,
    session_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    // EchoAgent requires a session_id; pass an empty string if none — it falls back
    // to the shared snapshot.
    let sid = session_id.unwrap_or_default();
    let params = raw_params(&serde_json::json!({ "sessionId": sid }));
    call_ext(&tx, "echo.agent/plugins/list", params)
        .await
        .map_err(|e| e.to_string())
}

/// Execute a plugin action via `echo.agent/plugins/action`. The frontend supplies
/// the action object verbatim (shape matches EchoAgent's `PluginsActionRequest`).
/// Returns the action's outcome.
#[tauri::command]
pub async fn plugins_action(
    state: State<'_, AppState>,
    session_id: String,
    action: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    let payload = serde_json::json!({ "sessionId": session_id, "action": action });
    let params = raw_params(&payload);
    call_ext(&tx, "echo.agent/plugins/action", params)
        .await
        .map_err(|e| e.to_string())
}

/// List marketplace sources + their plugins via `echo.agent/marketplace/list`.
/// Returns the raw `MarketplaceListResponse` JSON.
#[tauri::command]
pub async fn marketplace_list(
    state: State<'_, AppState>,
    session_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    let sid = session_id.unwrap_or_default();
    let params = raw_params(&serde_json::json!({ "sessionId": sid }));
    call_ext(&tx, "echo.agent/marketplace/list", params)
        .await
        .map_err(|e| e.to_string())
}

/// Execute a marketplace action (install/uninstall/refresh/update/add_source/
/// remove_source). `action` shape matches EchoAgent's `MarketplaceAction` enum.
#[tauri::command]
pub async fn marketplace_action(
    state: State<'_, AppState>,
    session_id: String,
    action: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    let payload = serde_json::json!({ "sessionId": session_id, "action": action });
    let params = raw_params(&payload);
    call_ext(&tx, "echo.agent/marketplace/action", params)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::parse_slash_commands;

    #[test]
    fn parses_current_acp_command_shape_and_sources() {
        let value = serde_json::json!({
            "commands": [
                {
                    "name": "compact",
                    "description": "Compress history",
                    "input": { "hint": "what to preserve" }
                },
                {
                    "name": "review",
                    "description": "Review changes",
                    "input": { "hint": "optional scope" },
                    "_meta": { "scope": "project", "path": "/repo/SKILL.md" }
                },
                {
                    "name": "acme:deploy",
                    "description": "Deploy",
                    "_meta": { "scope": "project", "pluginName": "acme" }
                },
                {
                    "name": "release",
                    "description": "Release workflow",
                    "_meta": { "workflowSource": "project" }
                }
            ]
        });

        let commands = parse_slash_commands(&value);
        assert_eq!(commands.len(), 4);
        assert_eq!(
            commands[0].argument_hint.as_deref(),
            Some("what to preserve")
        );
        assert_eq!(commands[0].source.as_deref(), Some("builtin"));
        assert_eq!(commands[1].source.as_deref(), Some("skill:project"));
        assert_eq!(commands[2].source.as_deref(), Some("plugin:acme"));
        assert_eq!(commands[3].source.as_deref(), Some("workflow:project"));
    }

    #[test]
    fn accepts_legacy_flat_command_shape_and_skips_invalid_rows() {
        let value = serde_json::json!([
            {
                "name": "legacy",
                "description": "Legacy",
                "argumentHint": "value",
                "source": "ignored-legacy-source"
            },
            { "description": "missing name" }
        ]);

        let commands = parse_slash_commands(&value);
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].name, "legacy");
        assert_eq!(commands[0].argument_hint.as_deref(), Some("value"));
        assert_eq!(commands[0].source.as_deref(), Some("builtin"));
    }
}
