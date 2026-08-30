//! Session history discovery.
//!
//! EchoAgent persists sessions under `~/.echo-agent/sessions/<encoded-cwd>/<session-id>/`
//! with a `summary.json` in each. We list them (best-effort) for the sidebar.
//! The encoding of <encoded-cwd> is EchoAgent's `encode_cwd_dirname` (with a blake3
//! hash fallback for long paths); rather than reproduce that exactly we scan
//! ALL session directories and filter by the matching cwd inside summary.json.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_git_repo: Option<bool>,
    /// Pinned-to-top flag (EchoAgent-only state, NOT a EchoAgent field).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    /// Archived (hidden from sidebar) flag (EchoAgent-only state, NOT a EchoAgent field).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    /// Model id bound to this session, if recorded in summary.json.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_model_id: Option<String>,
    /// Expert id bound to this session (EchoAgent-only state).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expert_id: Option<String>,
    /// Expert display name (EchoAgent-only state).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expert_name: Option<String>,
    /// Expert local avatar path (EchoAgent-only state).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expert_avatar: Option<String>,
}

/// Subset of EchoAgent's `Summary` struct (see `xai-grok-shell/src/session/persistence.rs:790`).
/// We only deserialize the fields we care about; unknown fields are ignored.
///
/// Display priority for `title` matches EchoAgent's own `display_title`:
/// `generated_title` (LLM-generated or manual /rename) > `session_summary`
/// (user's first message text).
#[derive(Debug, Deserialize)]
struct SummaryFile {
    /// User's first prompt text (legacy title field).
    #[serde(default, rename = "session_summary", alias = "summary")]
    summary: Option<String>,
    /// LLM-generated or manually-set title. Preferred over `summary`.
    #[serde(default)]
    generated_title: Option<String>,
    #[serde(default)]
    title_is_manual: Option<bool>,
    /// May live at the top level OR inside `info.id` — we read both.
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    /// EchoAgent bumps this on any activity; preferred when `updated_at` is stale.
    #[serde(default)]
    last_active_at: Option<String>,
    #[serde(default)]
    current_model_id: Option<String>,
    #[serde(default)]
    git_root_dir: Option<String>,
    /// Nested `info.id` / `info.cwd` shape (EchoAgent's Summary wraps these in Info).
    #[serde(default)]
    info: Option<SummaryInfo>,
    #[serde(default)]
    #[allow(dead_code)]
    mtime: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SummaryInfo {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
}

fn display_title(summary: &SummaryFile) -> Option<String> {
    let generated = summary
        .generated_title
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty());

    // A manual rename is user-authored, so preserve it verbatim. Automatic
    // titles must pass the reasoning-markup filter, including legacy titles
    // already persisted before that filter existed.
    if summary.title_is_manual == Some(true) {
        if let Some(title) = generated {
            return Some(title.to_string());
        }
    } else if let Some(title) = generated.and_then(crate::session_title::clean_auto_title) {
        return Some(title);
    }

    summary
        .summary
        .as_deref()
        .and_then(crate::session_title::clean_auto_title)
}

/// List sessions for a given cwd. Reads `~/.echo-agent/sessions/**/*.json` and
/// filters by cwd. Best-effort: missing/invalid entries are skipped.
pub fn list_sessions(cwd: &str) -> Vec<SessionSummary> {
    let sessions_root = agent_sessions_root();
    let mut out = Vec::new();

    let Ok(cwd_dirs) = std::fs::read_dir(&sessions_root) else {
        return out;
    };
    for cwd_entry in cwd_dirs.flatten() {
        let cwd_path = cwd_entry.path();
        if !cwd_path.is_dir() {
            continue;
        }
        let Ok(session_dirs) = std::fs::read_dir(&cwd_path) else {
            continue;
        };
        for sess_entry in session_dirs.flatten() {
            let sess_path = sess_entry.path();
            let summary_path = sess_path.join("summary.json");
            let Ok(content) = std::fs::read_to_string(&summary_path) else {
                continue;
            };
            let Ok(s) = serde_json::from_str::<SummaryFile>(&content) else {
                continue;
            };
            // Filter by cwd: trust summary.json's `cwd` (or nested `info.cwd`)
            // since the encoded dirname is not reliably reversible.
            let entry_cwd = s
                .cwd
                .clone()
                .or_else(|| s.info.as_ref().and_then(|i| i.cwd.clone()))
                .unwrap_or_default();
            if !entry_cwd.is_empty() && entry_cwd != cwd {
                continue;
            }
            let session_id = s
                .session_id
                .clone()
                .or_else(|| s.info.as_ref().and_then(|i| i.id.clone()))
                .or_else(|| {
                    sess_path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .map(String::from)
                })
                .unwrap_or_default();
            if session_id.is_empty() {
                continue;
            }
            // Title: generated_title wins over legacy `summary`. This matches
            // EchoAgent's display_title precedence (persistence.rs:961-968).
            let title = display_title(&s).unwrap_or_else(|| "未命名会话".into());
            let updated_at = s.updated_at.clone().or_else(|| s.last_active_at.clone());
            let is_git_repo = s.git_root_dir.as_ref().map(|p| !p.is_empty());
            out.push(SessionSummary {
                session_id,
                title,
                updated_at,
                cwd: if entry_cwd.is_empty() {
                    cwd.to_string()
                } else {
                    entry_cwd
                },
                is_git_repo,
                pinned: None,
                archived: None,
                current_model_id: s.current_model_id.clone(),
                expert_id: None,
                expert_name: None,
                expert_avatar: None,
            });
        }
    }
    // Merge EchoAgent-only pinned/archived state (sidecar file, since EchoAgent's
    // Summary has no such fields and would clobber any we tried to add).
    let state = crate::meta::read_state();
    let pinned = state.pinned_set();
    let archived = state.archived_set();
    let experts = state.expert_map();
    // Archived sessions are hidden from the sidebar entirely.
    out.retain(|entry| !archived.contains(&entry.session_id));
    for entry in &mut out {
        entry.pinned = Some(pinned.contains(&entry.session_id));
        entry.archived = Some(false);
        if let Some(binding) = experts.get(&entry.session_id) {
            entry.expert_id = Some(binding.expert_id.clone());
            entry.expert_name = Some(binding.expert_name.clone());
            entry.expert_avatar = binding.avatar_local.clone();
        }
    }
    // Sort: pinned first, then by updated_at descending (falling back to the
    // session_id, which is a UUIDv7 — roughly chronological).
    out.sort_by(|a, b| {
        b.pinned
            .unwrap_or(false)
            .cmp(&a.pinned.unwrap_or(false))
            .then_with(|| {
                b.updated_at
                    .cmp(&a.updated_at)
                    .then_with(|| b.session_id.cmp(&a.session_id))
            })
    });
    out
}

/// A discovered workspace (working directory EchoAgent has run sessions in).
/// Used to populate the Composer's "选择工作空间" dropdown.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    /// Absolute path of the working directory.
    pub cwd: String,
    /// Number of sessions recorded under this cwd.
    pub session_count: usize,
    /// Title of the most recent session under this cwd (for display).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_title: Option<String>,
}

/// Scan `~/.echo-agent/sessions/**/summary.json` and collapse the results by cwd.
/// Unlike `list_sessions` (which filters to one cwd), this returns every cwd
/// EchoAgent has ever seen, deduplicated, with a session count per cwd. Used to
/// populate the workspace picker. Best-effort: malformed entries are skipped.
pub fn list_workspaces() -> Vec<WorkspaceInfo> {
    let sessions_root = agent_sessions_root();
    // cwd -> (count, last_title)
    let mut map: std::collections::HashMap<String, (usize, Option<String>)> =
        std::collections::HashMap::new();

    let Ok(cwd_dirs) = std::fs::read_dir(&sessions_root) else {
        return Vec::new();
    };
    for cwd_entry in cwd_dirs.flatten() {
        let cwd_path = cwd_entry.path();
        if !cwd_path.is_dir() {
            continue;
        }
        let Ok(session_dirs) = std::fs::read_dir(&cwd_path) else {
            continue;
        };
        for sess_entry in session_dirs.flatten() {
            let summary_path = sess_entry.path().join("summary.json");
            let Ok(content) = std::fs::read_to_string(&summary_path) else {
                continue;
            };
            let Ok(s) = serde_json::from_str::<SummaryFile>(&content) else {
                continue;
            };
            let title = display_title(&s);
            let entry_cwd = s.cwd.unwrap_or_default();
            if entry_cwd.is_empty() {
                continue;
            }
            let entry = map.entry(entry_cwd).or_insert((0, None));
            entry.0 += 1;
            // Keep the last non-empty summary as the display title.
            if let Some(title) = title {
                entry.1 = Some(title);
            }
        }
    }

    let mut out: Vec<WorkspaceInfo> = map
        .into_iter()
        .map(|(cwd, (session_count, last_title))| WorkspaceInfo {
            cwd,
            session_count,
            last_title,
        })
        .collect();
    // Busiest workspaces first (most sessions), tie-break alphabetically.
    out.sort_by(|a, b| {
        b.session_count
            .cmp(&a.session_count)
            .then(a.cwd.cmp(&b.cwd))
    });
    out
}

fn agent_sessions_root() -> PathBuf {
    crate::paths::echo_agent_home_dir().join("sessions")
}

#[cfg(test)]
mod tests {
    use super::{SummaryFile, display_title};

    fn summary(json: &str) -> SummaryFile {
        serde_json::from_str(json).expect("valid summary fixture")
    }

    #[test]
    fn reads_upstream_session_summary_field() {
        let parsed = summary(r#"{"session_summary":"First prompt"}"#);
        assert_eq!(display_title(&parsed).as_deref(), Some("First prompt"));
    }

    #[test]
    fn historical_auto_title_drops_reasoning_and_keeps_final_title() {
        let parsed = summary(
            r#"{
                "session_summary":"<think>private reasoning</think>Professional title",
                "generated_title":"<think>private reasoning</think>Professional title",
                "title_is_manual":false
            }"#,
        );
        assert_eq!(display_title(&parsed).as_deref(), Some("Professional title"));
    }

    #[test]
    fn historical_unclosed_reasoning_title_is_hidden() {
        let parsed = summary(
            r#"{
                "session_summary":"<think>The user only said hello twice",
                "generated_title":"<think>The user only said hello twice"
            }"#,
        );
        assert_eq!(display_title(&parsed), None);
    }

    #[test]
    fn manual_title_is_not_interpreted_as_model_reasoning() {
        let parsed = summary(
            r#"{
                "session_summary":"fallback",
                "generated_title":"Document <think> XML tag",
                "title_is_manual":true
            }"#,
        );
        assert_eq!(
            display_title(&parsed).as_deref(),
            Some("Document <think> XML tag")
        );
    }
}
