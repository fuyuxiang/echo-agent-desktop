//! EchoAgent's own metadata sidecar.
//!
//! EchoAgent's `summary.json` (and the in-memory `Summary` it serializes) does NOT
//! support a `pinned` field — it only knows its own schema, and writing an
//! unknown key would be clobbered the next time EchoAgent flushes. So we keep
//! EchoAgent-only state (currently: pinned + archived sessions) in a separate file:
//! `~/.echo-agent/echoagent-state.json`.
//!
//! Read on every `list_sessions` call and merged into the per-session
//! `SessionSummary`. The shape is intentionally a small versioned object so
//! we can extend it later (starred, hidden, custom tags, …) without a
//! migration.

use std::collections::{HashMap, HashSet};
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use fs2::FileExt;
use serde::{Deserialize, Serialize};

const STATE_VERSION: u32 = 1;
const MAX_STATE_BYTES: u64 = 1024 * 1024;
const MAX_SESSION_ENTRIES: usize = 10_000;
const MAX_SESSION_ID_CHARS: usize = 256;
const MAX_EXPERT_ID_CHARS: usize = 256;
const MAX_EXPERT_NAME_CHARS: usize = 512;
const MAX_EXPERT_SOURCE_CHARS: usize = 64;
const MAX_EXPERT_AVATAR_CHARS: usize = 4_096;

static STATE_TRANSACTION: OnceLock<Mutex<()>> = OnceLock::new();

fn state_transaction() -> &'static Mutex<()> {
    STATE_TRANSACTION.get_or_init(|| Mutex::new(()))
}

/// Expert binding for a session — records which expert was summoned.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpertBinding {
    /// Expert id (marketplace id or local agent name).
    pub expert_id: String,
    /// Display name shown in the UI badge.
    pub expert_name: String,
    /// "marketplace" | "local".
    pub source: String,
    /// Local avatar image path (for the topbar/composer badge).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_local: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EchoAgentState {
    /// Schema version for forward compatibility.
    pub version: u32,
    /// Session ids the user pinned to the top of the sidebar.
    #[serde(default)]
    pub pinned_sessions: Vec<String>,
    /// Session ids the user archived (hidden from the sidebar).
    #[serde(default)]
    pub archived_sessions: Vec<String>,
    /// Expert bindings: session_id → ExpertBinding.
    #[serde(default)]
    pub expert_sessions: HashMap<String, ExpertBinding>,
}

impl Default for EchoAgentState {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            pinned_sessions: Vec::new(),
            archived_sessions: Vec::new(),
            expert_sessions: HashMap::new(),
        }
    }
}

impl EchoAgentState {
    /// Snapshot of pinned ids as a `HashSet` for O(1) membership checks when
    /// merging into the session list.
    pub fn pinned_set(&self) -> HashSet<String> {
        self.pinned_sessions.iter().cloned().collect()
    }

    /// Snapshot of archived ids as a `HashSet` for O(1) membership checks when
    /// filtering the session list.
    pub fn archived_set(&self) -> HashSet<String> {
        self.archived_sessions.iter().cloned().collect()
    }

    /// Expert bindings map for merging into the session list.
    pub fn expert_map(&self) -> &HashMap<String, ExpertBinding> {
        &self.expert_sessions
    }
}

fn state_path() -> PathBuf {
    crate::paths::echo_agent_home_dir().join("echoagent-state.json")
}

fn valid_field(value: &str, max_chars: usize, allow_empty: bool) -> bool {
    (allow_empty || !value.trim().is_empty())
        && value.chars().count() <= max_chars
        && !value.chars().any(char::is_control)
}

fn valid_session_id(value: &str) -> bool {
    valid_field(value, MAX_SESSION_ID_CHARS, false)
}

fn validate_binding(binding: &ExpertBinding) -> Result<(), String> {
    if !valid_field(&binding.expert_id, MAX_EXPERT_ID_CHARS, false) {
        return Err("专家 ID 无效或过长".into());
    }
    if !valid_field(&binding.expert_name, MAX_EXPERT_NAME_CHARS, false) {
        return Err("专家名称无效或过长".into());
    }
    if !valid_field(&binding.source, MAX_EXPERT_SOURCE_CHARS, false) {
        return Err("专家来源无效或过长".into());
    }
    if binding
        .avatar_local
        .as_deref()
        .is_some_and(|value| !valid_field(value, MAX_EXPERT_AVATAR_CHARS, false))
    {
        return Err("专家头像路径无效或过长".into());
    }
    Ok(())
}

fn validate_state(state: &EchoAgentState) -> Result<(), String> {
    if state.version != STATE_VERSION {
        return Err(format!(
            "unsupported EchoAgent state version: {}",
            state.version
        ));
    }
    if state.pinned_sessions.len() > MAX_SESSION_ENTRIES
        || state.archived_sessions.len() > MAX_SESSION_ENTRIES
        || state.expert_sessions.len() > MAX_SESSION_ENTRIES
    {
        return Err("会话元数据条目超过安全上限".into());
    }
    if state
        .pinned_sessions
        .iter()
        .chain(&state.archived_sessions)
        .any(|value| !valid_session_id(value))
    {
        return Err("会话元数据包含无效会话 ID".into());
    }
    for (session_id, binding) in &state.expert_sessions {
        if !valid_session_id(session_id) {
            return Err("专家绑定包含无效会话 ID".into());
        }
        validate_binding(binding)?;
    }
    Ok(())
}

fn sanitize_state(mut state: EchoAgentState) -> EchoAgentState {
    if state.version != STATE_VERSION {
        return EchoAgentState::default();
    }
    let mut pinned_seen = HashSet::new();
    state.pinned_sessions.retain(|value| {
        valid_session_id(value)
            && pinned_seen.insert(value.clone())
            && pinned_seen.len() <= MAX_SESSION_ENTRIES
    });
    let mut archived_seen = HashSet::new();
    state.archived_sessions.retain(|value| {
        valid_session_id(value)
            && archived_seen.insert(value.clone())
            && archived_seen.len() <= MAX_SESSION_ENTRIES
    });
    state.expert_sessions.retain(|session_id, binding| {
        valid_session_id(session_id) && validate_binding(binding).is_ok()
    });
    if state.expert_sessions.len() > MAX_SESSION_ENTRIES {
        let mut keys = state.expert_sessions.keys().cloned().collect::<Vec<_>>();
        keys.sort();
        for key in keys.into_iter().skip(MAX_SESSION_ENTRIES) {
            state.expert_sessions.remove(&key);
        }
    }
    state
}

fn read_state_from(path: &Path, strict: bool) -> Result<EchoAgentState, String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(EchoAgentState::default())
        }
        Err(error) => return Err(format!("inspect state {}: {error}", path.display())),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "EchoAgent state must be a regular file: {}",
            path.display()
        ));
    }
    if metadata.len() > MAX_STATE_BYTES {
        return Err(format!(
            "EchoAgent state exceeds {} MiB",
            MAX_STATE_BYTES / 1024 / 1024
        ));
    }
    let bytes = crate::shell_fs::read_regular_file_bounded(path, MAX_STATE_BYTES)
        .map_err(|error| format!("read state {}: {error}", path.display()))?;
    let state: EchoAgentState = serde_json::from_slice(&bytes)
        .map_err(|error| format!("parse state {}: {error}", path.display()))?;
    if strict {
        validate_state(&state)?;
        Ok(state)
    } else {
        Ok(sanitize_state(state))
    }
}

fn with_state_file_lock<T>(
    path: &Path,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _process_guard = state_transaction()
        .lock()
        .map_err(|_| "EchoAgent state transaction lock is poisoned".to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("state path has no parent: {}", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("create state dir {}: {error}", parent.display()))?;
    crate::paths::harden_private_dir(parent)?;
    let lock_path = parent.join(".echoagent-state.lock");
    if std::fs::symlink_metadata(&lock_path).is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err(format!(
            "state lock must not be a symlink: {}",
            lock_path.display()
        ));
    }
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let lock_file = options
        .open(&lock_path)
        .map_err(|error| format!("open state lock {}: {error}", lock_path.display()))?;
    crate::paths::harden_private_file(&lock_path)?;
    let mut acquired = false;
    for _ in 0..200 {
        match lock_file.try_lock_exclusive() {
            Ok(()) => {
                acquired = true;
                break;
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.raw_os_error() == fs2::lock_contended_error().raw_os_error() =>
            {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(error) => return Err(format!("lock state {}: {error}", lock_path.display())),
        }
    }
    if !acquired {
        return Err(format!(
            "timed out waiting for EchoAgent state lock {}",
            lock_path.display()
        ));
    }
    let result = operation();
    let unlock = FileExt::unlock(&lock_file)
        .map_err(|error| format!("unlock state {}: {error}", lock_path.display()));
    match (result, unlock) {
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Ok(value), Ok(())) => Ok(value),
    }
}

fn write_state_to(path: &Path, state: &EchoAgentState) -> Result<(), String> {
    validate_state(state)?;
    let body = serde_json::to_vec_pretty(state)
        .map_err(|error| format!("serialize EchoAgent state: {error}"))?;
    if body.len() as u64 > MAX_STATE_BYTES {
        return Err(format!(
            "EchoAgent state exceeds {} MiB",
            MAX_STATE_BYTES / 1024 / 1024
        ));
    }
    crate::paths::write_private_file(path, &body)
}

fn update_state_at<T>(
    path: &Path,
    operation: impl FnOnce(&mut EchoAgentState) -> Result<(T, bool), String>,
) -> Result<T, String> {
    with_state_file_lock(path, || {
        // Mutations are deliberately strict: malformed, oversized or future
        // state is never silently replaced with defaults.
        let mut state = read_state_from(path, true)?;
        let (result, changed) = operation(&mut state)?;
        if changed {
            write_state_to(path, &state)?;
        }
        Ok(result)
    })
}

/// Read EchoAgent state. Missing/corrupt → default (we never block startup on
/// sidecar state; a corrupt file is left in place rather than rewritten so the
/// user can recover it manually if needed).
pub fn read_state() -> EchoAgentState {
    let path = state_path();
    with_state_file_lock(&path, || read_state_from(&path, false)).unwrap_or_default()
}

fn set_pinned_at(path: &Path, session_id: &str, pinned: bool) -> Result<bool, String> {
    if !valid_session_id(session_id) {
        return Err("会话 ID 无效或过长".into());
    }
    update_state_at(path, |state| {
        let already = state
            .pinned_sessions
            .iter()
            .any(|value| value == session_id);
        if pinned && !already {
            if state.pinned_sessions.len() >= MAX_SESSION_ENTRIES {
                return Err("置顶会话数量超过安全上限".into());
            }
            state.pinned_sessions.push(session_id.to_string());
            Ok((pinned, true))
        } else if !pinned && already {
            state.pinned_sessions.retain(|value| value != session_id);
            Ok((pinned, true))
        } else {
            Ok((pinned, false))
        }
    })
}

/// Set the pinned flag for one session. Returns the new pinned state so the
/// command layer can echo it back to the frontend.
pub fn set_pinned(session_id: &str, pinned: bool) -> Result<bool, String> {
    set_pinned_at(&state_path(), session_id, pinned)
}

fn set_archived_at(path: &Path, session_id: &str, archived: bool) -> Result<bool, String> {
    if !valid_session_id(session_id) {
        return Err("会话 ID 无效或过长".into());
    }
    update_state_at(path, |state| {
        let already = state
            .archived_sessions
            .iter()
            .any(|value| value == session_id);
        if archived && !already {
            if state.archived_sessions.len() >= MAX_SESSION_ENTRIES {
                return Err("归档会话数量超过安全上限".into());
            }
            state.archived_sessions.push(session_id.to_string());
            Ok((archived, true))
        } else if !archived && already {
            state.archived_sessions.retain(|value| value != session_id);
            Ok((archived, true))
        } else {
            Ok((archived, false))
        }
    })
}

/// Set the archived flag for one session. Returns the new archived state so
/// the command layer can echo it back to the frontend.
pub fn set_archived(session_id: &str, archived: bool) -> Result<bool, String> {
    set_archived_at(&state_path(), session_id, archived)
}

/// Bind an expert to a session. Overwrites any previous binding for the same
/// session id. Returns `true` on success.
pub fn set_expert(session_id: &str, binding: ExpertBinding) -> Result<bool, String> {
    if !valid_session_id(session_id) {
        return Err("会话 ID 无效或过长".into());
    }
    validate_binding(&binding)?;
    update_state_at(&state_path(), |state| {
        if !state.expert_sessions.contains_key(session_id)
            && state.expert_sessions.len() >= MAX_SESSION_ENTRIES
        {
            return Err("专家绑定数量超过安全上限".into());
        }
        state
            .expert_sessions
            .insert(session_id.to_string(), binding);
        Ok((true, true))
    })
}

/// Remove the expert binding for a session. Returns `true` if a binding was
/// removed, `false` if there was none.
pub fn clear_expert(session_id: &str) -> Result<bool, String> {
    if !valid_session_id(session_id) {
        return Err("会话 ID 无效或过长".into());
    }
    update_state_at(&state_path(), |state| {
        let removed = state.expert_sessions.remove(session_id).is_some();
        Ok((removed, removed))
    })
}

// ---------- unit tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    // --- EchoAgentState::default ---

    #[test]
    fn default_state() {
        let state = EchoAgentState::default();
        assert_eq!(state.version, 1);
        assert!(state.pinned_sessions.is_empty());
        assert!(state.archived_sessions.is_empty());
    }

    // --- pinned_set / archived_set ---

    #[test]
    fn pinned_set_converts_to_hashset() {
        let state = EchoAgentState {
            version: 1,
            pinned_sessions: vec!["s1".into(), "s2".into(), "s1".into()],
            archived_sessions: vec![],
            expert_sessions: HashMap::new(),
        };
        let set = state.pinned_set();
        assert_eq!(set.len(), 2); // deduplicated
        assert!(set.contains("s1"));
        assert!(set.contains("s2"));
    }

    #[test]
    fn archived_set_converts_to_hashset() {
        let state = EchoAgentState {
            version: 1,
            pinned_sessions: vec![],
            archived_sessions: vec!["a1".into(), "a2".into()],
            expert_sessions: HashMap::new(),
        };
        let set = state.archived_set();
        assert_eq!(set.len(), 2);
        assert!(set.contains("a1"));
        assert!(set.contains("a2"));
    }

    #[test]
    fn empty_sets() {
        let state = EchoAgentState::default();
        assert!(state.pinned_set().is_empty());
        assert!(state.archived_set().is_empty());
    }

    // --- serde round-trip ---

    #[test]
    fn state_serde_roundtrip() {
        let state = EchoAgentState {
            version: 1,
            pinned_sessions: vec!["s1".into()],
            archived_sessions: vec!["a1".into(), "a2".into()],
            expert_sessions: HashMap::new(),
        };
        let json = serde_json::to_string(&state).unwrap();
        let parsed: EchoAgentState = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.version, 1);
        assert_eq!(parsed.pinned_sessions, vec!["s1"]);
        assert_eq!(parsed.archived_sessions, vec!["a1", "a2"]);
    }

    #[test]
    fn state_deserialize_with_missing_fields() {
        // Old format might not have all fields
        let json = r#"{"version":1}"#;
        let state: EchoAgentState = serde_json::from_str(json).unwrap();
        assert!(state.pinned_sessions.is_empty());
        assert!(state.archived_sessions.is_empty());
    }

    #[test]
    fn set_pinned_and_archived_lifecycle() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("echoagent-state.json");

        // --- pinned lifecycle ---
        // Pin
        let result = set_pinned_at(&path, "session-1", true).unwrap();
        assert!(result);
        let state = read_state_from(&path, false).unwrap();
        assert!(state.pinned_sessions.contains(&"session-1".to_string()));

        // Pin again (idempotent — no duplicate)
        let result = set_pinned_at(&path, "session-1", true).unwrap();
        assert!(result);
        let state = read_state_from(&path, false).unwrap();
        assert_eq!(
            state
                .pinned_sessions
                .iter()
                .filter(|s| *s == "session-1")
                .count(),
            1
        );

        // Unpin
        let result = set_pinned_at(&path, "session-1", false).unwrap();
        assert!(!result);
        let state = read_state_from(&path, false).unwrap();
        assert!(!state.pinned_sessions.contains(&"session-1".to_string()));

        // Unpin again (idempotent)
        let result = set_pinned_at(&path, "session-1", false).unwrap();
        assert!(!result);

        // --- archived lifecycle ---
        // Archive
        let result = set_archived_at(&path, "session-2", true).unwrap();
        assert!(result);
        let state = read_state_from(&path, false).unwrap();
        assert!(state.archived_sessions.contains(&"session-2".to_string()));

        // Archive again (idempotent)
        let result = set_archived_at(&path, "session-2", true).unwrap();
        assert!(result);
        let state = read_state_from(&path, false).unwrap();
        assert_eq!(
            state
                .archived_sessions
                .iter()
                .filter(|s| *s == "session-2")
                .count(),
            1
        );

        // Unarchive
        let result = set_archived_at(&path, "session-2", false).unwrap();
        assert!(!result);
        let state = read_state_from(&path, false).unwrap();
        assert!(!state.archived_sessions.contains(&"session-2".to_string()));

        // A malformed state remains recoverable and must never be replaced by
        // a mutation that silently starts from defaults.
        let corrupt = b"{not valid json";
        std::fs::write(&path, corrupt).unwrap();
        assert!(set_pinned_at(&path, "session-3", true).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), corrupt);

        // Oversized files are rejected before allocation and invalid inputs
        // never enter the persisted collections.
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_STATE_BYTES + 1).unwrap();
        assert!(read_state_from(&path, true).is_err());
        assert!(set_pinned_at(&path, &"x".repeat(MAX_SESSION_ID_CHARS + 1), true).is_err());
    }

    #[test]
    fn state_validation_bounds_expert_fields_and_collection_sizes() {
        let mut state = EchoAgentState::default();
        state.expert_sessions.insert(
            "session".into(),
            ExpertBinding {
                expert_id: "id".into(),
                expert_name: "x".repeat(MAX_EXPERT_NAME_CHARS + 1),
                source: "local".into(),
                avatar_local: None,
            },
        );
        assert!(validate_state(&state).is_err());

        let mut too_many = EchoAgentState::default();
        too_many.pinned_sessions = (0..=MAX_SESSION_ENTRIES)
            .map(|index| format!("session-{index}"))
            .collect();
        assert!(validate_state(&too_many).is_err());
    }
}
