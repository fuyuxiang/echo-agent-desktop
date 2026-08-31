//! Higher-level EchoAgent admin extensions — bridges the upstream `echo.agent/*` methods that
//! drive EchoAgent-equivalent features:
//!
//! - **Memory** (资料库): read/rewrite canonical global + hashed workspace
//!   memory, flush active sessions and run consolidation.
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

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;
use xai_grok_shell::session::memory::{
    storage::normalize_memory_content, MemoryScope, MemoryStorage,
};

use crate::commands::AppState;
use crate::ext::{call_ext, raw_params};

// ========================================================================
// Memory (资料库)
// ========================================================================

const MEMORY_FILE: &str = "MEMORY.md";
const MAX_MEMORY_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// One canonical memory document. Global and workspace `MEMORY.md` files are
/// editable; per-session logs are visible for auditing but intentionally
/// read-only because the Runtime owns their lifecycle.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    /// "global" | "workspace" | "session".
    pub scope: String,
    /// `MEMORY.md` for editable documents; a basename for session logs.
    pub path: String,
    pub content: String,
    pub size: u64,
    /// SHA-256 of the file contents, used for optimistic concurrency control.
    pub revision: String,
    /// Last modified timestamp (RFC 3339), when available.
    pub modified_at: Option<String>,
    pub read_only: bool,
}

fn global_memory_dir() -> PathBuf {
    crate::paths::echo_agent_home_dir().join("memory")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MemoryEntryScope {
    Global,
    Workspace,
    Session,
}

impl MemoryEntryScope {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "global" => Ok(Self::Global),
            "workspace" => Ok(Self::Workspace),
            "session" => Ok(Self::Session),
            _ => Err(format!("unknown memory scope: {value}")),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Workspace => "workspace",
            Self::Session => "session",
        }
    }

    fn writable(self) -> Result<MemoryScope, String> {
        match self {
            Self::Global => Ok(MemoryScope::Global),
            Self::Workspace => Ok(MemoryScope::Workspace),
            Self::Session => Err("session memory logs are read-only".into()),
        }
    }
}

fn memory_storage(cwd: Option<&str>) -> Result<MemoryStorage, String> {
    let workspace = cwd
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")));
    if cwd.is_some() && !workspace.is_absolute() {
        return Err("cwd must be an absolute path".into());
    }
    Ok(MemoryStorage::new(
        &workspace,
        Some(global_memory_dir().as_path()),
    ))
}

fn normalized_cwd(cwd: Option<&str>) -> Option<&str> {
    cwd.filter(|value| !value.trim().is_empty())
}

fn resolve_memory_path(
    storage: &MemoryStorage,
    scope: MemoryEntryScope,
    relative: &str,
) -> Result<PathBuf, String> {
    match scope {
        MemoryEntryScope::Global => {
            if relative != MEMORY_FILE {
                return Err("global memory path must be MEMORY.md".into());
            }
            Ok(storage.global_memory_file())
        }
        MemoryEntryScope::Workspace => {
            if relative != MEMORY_FILE {
                return Err("workspace memory path must be MEMORY.md".into());
            }
            Ok(storage.workspace_memory_file())
        }
        MemoryEntryScope::Session => {
            let relative = Path::new(relative);
            if relative.components().count() != 1
                || relative.extension().and_then(|value| value.to_str()) != Some("md")
            {
                return Err("invalid session memory path".into());
            }
            Ok(storage.sessions_dir().join(relative))
        }
    }
}

fn file_revision(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(format!(
            "memory path must not be a symlink: {}",
            path.display()
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("inspect {}: {error}", path.display())),
    }
}

fn read_entry(
    storage: &MemoryStorage,
    scope: MemoryEntryScope,
    relative: &str,
) -> Result<MemoryEntry, String> {
    let path = resolve_memory_path(storage, scope, relative)?;
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|error| format!("read {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "memory path is not a regular file: {}",
            path.display()
        ));
    }
    if metadata.len() > MAX_MEMORY_FILE_BYTES {
        return Err(format!(
            "memory file exceeds {} MiB: {}",
            MAX_MEMORY_FILE_BYTES / 1024 / 1024,
            path.display()
        ));
    }
    let bytes =
        std::fs::read(&path).map_err(|error| format!("read {}: {error}", path.display()))?;
    if bytes.len() as u64 > MAX_MEMORY_FILE_BYTES {
        return Err(format!(
            "memory file exceeds {} MiB: {}",
            MAX_MEMORY_FILE_BYTES / 1024 / 1024,
            path.display()
        ));
    }
    let content = String::from_utf8(bytes.clone())
        .map_err(|_| format!("memory file is not valid UTF-8: {}", path.display()))?;
    let modified_at = metadata
        .modified()
        .ok()
        .map(chrono::DateTime::<chrono::Utc>::from)
        .map(|time| time.to_rfc3339());
    Ok(MemoryEntry {
        scope: scope.as_str().into(),
        path: relative.into(),
        content,
        size: metadata.len(),
        revision: file_revision(&bytes),
        modified_at,
        read_only: scope == MemoryEntryScope::Session,
    })
}

fn list_memory(storage: &MemoryStorage, include_workspace: bool) -> Vec<MemoryEntry> {
    let mut entries = Vec::new();
    if storage.global_memory_file().exists() {
        if let Ok(entry) = read_entry(storage, MemoryEntryScope::Global, MEMORY_FILE) {
            entries.push(entry);
        }
    }
    if !include_workspace {
        return entries;
    }
    if storage.workspace_memory_file().exists() {
        if let Ok(entry) = read_entry(storage, MemoryEntryScope::Workspace, MEMORY_FILE) {
            entries.push(entry);
        }
    }
    let mut session_names = std::fs::read_dir(storage.sessions_dir())
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            let path = entry.path();
            if !file_type.is_file()
                || path.extension().and_then(|value| value.to_str()) != Some("md")
            {
                return None;
            }
            path.file_name()?.to_str().map(str::to_owned)
        })
        .collect::<Vec<_>>();
    session_names.sort_by(|left, right| right.cmp(left));
    entries.extend(
        session_names
            .into_iter()
            .filter_map(|name| read_entry(storage, MemoryEntryScope::Session, &name).ok()),
    );
    entries
}

#[tauri::command]
pub fn memory_list(cwd: Option<String>) -> Result<Vec<MemoryEntry>, String> {
    let cwd = normalized_cwd(cwd.as_deref());
    let storage = memory_storage(cwd)?;
    Ok(list_memory(&storage, cwd.is_some()))
}

#[tauri::command]
pub fn memory_get(scope: String, path: String, cwd: Option<String>) -> Result<String, String> {
    let scope = MemoryEntryScope::parse(&scope)?;
    let cwd = normalized_cwd(cwd.as_deref());
    if scope != MemoryEntryScope::Global && cwd.is_none() {
        return Err("cwd required for workspace memory".into());
    }
    Ok(read_entry(&memory_storage(cwd)?, scope, &path)?.content)
}

fn check_expected_revision(path: &Path, expected: Option<&str>) -> Result<(), String> {
    match (std::fs::read(path), expected) {
        (Ok(bytes), Some(value)) if file_revision(&bytes) == value => Ok(()),
        (Ok(_), _) => Err("记忆已被其他会话修改，请刷新后重试".into()),
        (Err(error), Some("")) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        (Err(error), _) if error.kind() == std::io::ErrorKind::NotFound => {
            Err("记忆文件已被删除，请刷新后重试".into())
        }
        (Err(error), _) => Err(format!("read {}: {error}", path.display())),
    }
}

#[tauri::command]
pub fn memory_save(
    scope: String,
    path: String,
    content: String,
    cwd: Option<String>,
    expected_revision: Option<String>,
) -> Result<MemoryEntry, String> {
    if content.len() as u64 > MAX_MEMORY_FILE_BYTES {
        return Err(format!(
            "memory content exceeds {} MiB",
            MAX_MEMORY_FILE_BYTES / 1024 / 1024
        ));
    }
    let scope = MemoryEntryScope::parse(&scope)?;
    scope.writable()?;
    let cwd = normalized_cwd(cwd.as_deref());
    if scope == MemoryEntryScope::Workspace && cwd.is_none() {
        return Err("cwd required for workspace memory".into());
    }
    let storage = memory_storage(cwd)?;
    let target = resolve_memory_path(&storage, scope, &path)?;
    reject_symlink(&target)?;
    check_expected_revision(&target, expected_revision.as_deref())?;
    crate::paths::write_private_file(&target, content.as_bytes())?;
    read_entry(&storage, scope, &path)
}

/// Append one normalized note to a canonical memory file. This is the write
/// primitive used by the editor's "new memory" action and `/remember`.
#[tauri::command]
pub fn memory_append(
    scope: String,
    content: String,
    cwd: Option<String>,
) -> Result<MemoryEntry, String> {
    if content.trim().is_empty() {
        return Err("memory content cannot be empty".into());
    }
    if content.len() as u64 > MAX_MEMORY_FILE_BYTES {
        return Err(format!(
            "memory content exceeds {} MiB",
            MAX_MEMORY_FILE_BYTES / 1024 / 1024
        ));
    }
    let scope = MemoryEntryScope::parse(&scope)?;
    let runtime_scope = scope.writable()?;
    let cwd = normalized_cwd(cwd.as_deref());
    if scope == MemoryEntryScope::Workspace && cwd.is_none() {
        return Err("cwd required for workspace memory".into());
    }
    let storage = memory_storage(cwd)?;
    let target = resolve_memory_path(&storage, scope, MEMORY_FILE)?;
    reject_symlink(&target)?;
    let normalized = normalize_memory_content(&content);
    let existing_size = std::fs::metadata(&target)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let separator_size = u64::from(existing_size > 0) * 2;
    if existing_size
        .saturating_add(separator_size)
        .saturating_add(normalized.len() as u64)
        > MAX_MEMORY_FILE_BYTES
    {
        return Err(format!(
            "memory file would exceed {} MiB",
            MAX_MEMORY_FILE_BYTES / 1024 / 1024
        ));
    }
    storage
        .append_to_memory(runtime_scope, &normalized)
        .map_err(|error| format!("append memory: {error}"))?;
    crate::paths::harden_private_file(&target)?;
    read_entry(&storage, scope, MEMORY_FILE)
}

#[tauri::command]
pub fn memory_delete(
    scope: String,
    path: String,
    cwd: Option<String>,
    expected_revision: Option<String>,
) -> Result<(), String> {
    let scope = MemoryEntryScope::parse(&scope)?;
    scope.writable()?;
    let cwd = normalized_cwd(cwd.as_deref());
    if scope == MemoryEntryScope::Workspace && cwd.is_none() {
        return Err("cwd required for workspace memory".into());
    }
    let storage = memory_storage(cwd)?;
    let target = resolve_memory_path(&storage, scope, &path)?;
    reject_symlink(&target)?;
    check_expected_revision(&target, expected_revision.as_deref())?;
    std::fs::remove_file(&target).map_err(|error| format!("delete {}: {error}", target.display()))
}

/// Rewrite one editor buffer via the active session's model. The Runtime only
/// returns rewritten text; the caller explicitly reviews and saves it.
#[tauri::command]
pub async fn memory_rewrite(
    state: State<'_, AppState>,
    session_id: String,
    raw_text: String,
    context_summary: String,
) -> Result<String, String> {
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    let params = raw_params(&serde_json::json!({
        "sessionId": session_id,
        "rawText": raw_text,
        "contextSummary": context_summary,
    }));
    let value: serde_json::Value = call_ext(&tx, "echo.agent/memory/rewrite", params)
        .await
        .map_err(|e| e.to_string())?;
    value
        .get("rewritten")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "memory rewrite response missing rewritten text".into())
}

/// Flush in-flight memory writes to disk (`echo.agent/memory/flush`).
#[tauri::command]
pub async fn memory_flush(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    // The upstream flush request predates the camelCase rewrite request and
    // intentionally deserializes this one field as snake_case.
    let params = raw_params(&serde_json::json!({ "session_id": session_id }));
    let _: serde_json::Value = call_ext(&tx, "echo.agent/memory/flush", params)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Run the Runtime's `/dream` consolidation for the active session. This
/// bypasses the periodic time/session gates while preserving Runtime locking,
/// indexing, notifications and failure handling.
#[tauri::command]
pub async fn memory_dream(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    crate::agent_runtime::prompt(&tx, &session_id, "/dream")
        .await
        .map_err(|error| error.to_string())
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
    use super::{
        check_expected_revision, file_revision, list_memory, parse_slash_commands,
        resolve_memory_path, MemoryEntryScope, MemoryStorage,
    };

    #[test]
    fn memory_list_uses_runtime_layout_and_marks_sessions_read_only() {
        let root = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let storage = MemoryStorage::new(cwd.path(), Some(root.path()));
        std::fs::create_dir_all(storage.sessions_dir()).unwrap();
        std::fs::write(storage.global_memory_file(), "# Global\n").unwrap();
        std::fs::write(storage.workspace_memory_file(), "# Workspace\n").unwrap();
        std::fs::write(
            storage.sessions_dir().join("2026-08-31-test.md"),
            "# Session\n",
        )
        .unwrap();

        let entries = list_memory(&storage, true);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].scope, "global");
        assert_eq!(entries[1].scope, "workspace");
        assert_eq!(entries[2].scope, "session");
        assert!(!entries[0].read_only);
        assert!(entries[2].read_only);
        assert_eq!(entries[0].revision, file_revision(b"# Global\n"));
    }

    #[test]
    fn memory_paths_reject_arbitrary_and_traversal_paths() {
        let root = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let storage = MemoryStorage::new(cwd.path(), Some(root.path()));

        assert!(resolve_memory_path(&storage, MemoryEntryScope::Global, "notes.md").is_err());
        assert!(resolve_memory_path(&storage, MemoryEntryScope::Session, "../MEMORY.md").is_err());
        assert!(MemoryEntryScope::parse("unexpected").is_err());
    }

    #[test]
    fn memory_revision_check_detects_stale_edits_and_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("MEMORY.md");
        std::fs::write(&path, "first").unwrap();
        let revision = file_revision(b"first");
        assert!(check_expected_revision(&path, Some(&revision)).is_ok());
        std::fs::write(&path, "second").unwrap();
        assert!(check_expected_revision(&path, Some(&revision)).is_err());

        let missing = dir.path().join("missing.md");
        assert!(check_expected_revision(&missing, Some("")).is_ok());
        assert!(check_expected_revision(&missing, None).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn memory_writes_reject_symlinked_canonical_files() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside.md");
        let link = dir.path().join("MEMORY.md");
        std::fs::write(&outside, "private").unwrap();
        symlink(&outside, &link).unwrap();

        assert!(super::reject_symlink(&link).is_err());
    }

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
