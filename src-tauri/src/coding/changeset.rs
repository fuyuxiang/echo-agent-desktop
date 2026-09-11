//! Per-task change set. Records every file the Agent touched together with the
//! content it had before the task started, which is what makes a one-click
//! task rollback possible without reaching for Git history.
//!
//! Files that were already dirty when the task began are marked `pre_existing`
//! and are never restored or deleted by a rollback — the user's own uncommitted
//! work must survive any Agent operation.

use std::path::{Path, PathBuf};

use crate::coding_workspace::{git_snapshot, CodingGitFile};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::coding::store;
use crate::shell_fs::FilesystemAccess;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// Workspace-relative path, always forward-slashed.
    pub path: String,
    pub kind: ChangeKind,
    pub added: u32,
    pub removed: u32,
    /// Content before this task modified the file; `None` for newly created
    /// files, which are deleted rather than restored on rollback.
    pub baseline_content: Option<String>,
    /// The file already had uncommitted edits before the task started.
    pub pre_existing: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSet {
    pub task_id: String,
    /// Paths that were dirty before the task started.
    pub baseline_files: Vec<String>,
    pub changes: Vec<FileChange>,
    pub created_at: String,
    /// Paths whose diff the user actually opened. The diff-review quality gate
    /// needs evidence of review, not merely the existence of a change.
    #[serde(default)]
    pub reviewed_files: Vec<String>,
}

impl ChangeSet {
    pub fn total_added(&self) -> u32 {
        self.changes.iter().map(|change| change.added).sum()
    }

    pub fn total_removed(&self) -> u32 {
        self.changes.iter().map(|change| change.removed).sum()
    }

    pub fn is_pre_existing(&self, path: &str) -> bool {
        self.baseline_files.iter().any(|entry| entry == path)
    }
}

fn changeset_path(root: &Path, task_id: &str) -> PathBuf {
    store::task_dir(root, task_id).join("changeset.json")
}

pub fn load(root: &Path, task_id: &str) -> ChangeSet {
    store::read_json(&changeset_path(root, task_id)).unwrap_or_else(|| ChangeSet {
        task_id: task_id.to_string(),
        baseline_files: Vec::new(),
        changes: Vec::new(),
        created_at: chrono::Utc::now().to_rfc3339(),
        reviewed_files: Vec::new(),
    })
}

fn save(root: &Path, set: &ChangeSet) -> Result<(), String> {
    store::write_json(&changeset_path(root, &set.task_id), set)
}

/// Reject paths that try to escape the workspace before any write or delete.
fn resolve_in_workspace(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let normalized = relative.replace('\\', "/");
    if normalized.starts_with('/') || normalized.contains("..") || normalized.contains('\0') {
        return Err(format!("非法的工作区路径：{relative}"));
    }
    Ok(root.join(normalized))
}

pub fn capture_baseline(
    root: &Path,
    task_id: &str,
    dirty_files: Vec<String>,
) -> Result<ChangeSet, String> {
    let mut set = load(root, task_id);
    set.baseline_files = dirty_files;
    save(root, &set)?;
    Ok(set)
}

/// Record one file change. Re-recording the same path replaces its counters but
/// keeps the first baseline content, because only that snapshot can restore the
/// file to its pre-task state.
pub fn record_change(root: &Path, task_id: &str, change: FileChange) -> Result<ChangeSet, String> {
    let mut set = load(root, task_id);
    let pre_existing = change.pre_existing || set.is_pre_existing(&change.path);
    match set
        .changes
        .iter_mut()
        .find(|entry| entry.path == change.path)
    {
        Some(existing) => {
            existing.kind = change.kind;
            existing.added = change.added;
            existing.removed = change.removed;
            existing.pre_existing = pre_existing;
            if existing.baseline_content.is_none() {
                existing.baseline_content = change.baseline_content;
            }
        }
        None => set.changes.push(FileChange {
            pre_existing,
            ..change
        }),
    }
    save(root, &set)?;
    Ok(set)
}

/// Mark one file's diff as reviewed. Feeds the diff-review quality gate.
pub fn mark_reviewed(root: &Path, task_id: &str, path: &str) -> Result<ChangeSet, String> {
    let mut set = load(root, task_id);
    if !set.reviewed_files.iter().any(|entry| entry == path) {
        set.reviewed_files.push(path.to_string());
        save(root, &set)?;
    }
    Ok(set)
}

/// Read the on-disk content of a workspace file, bounded for safety. Returns
/// `None` if the file is missing, not a file, larger than the bound, or a
/// symlink — those are not states we want to capture as a baseline.
fn read_bounded(root: &Path, path: &str, max_bytes: u64) -> Option<String> {
    let target = resolve_in_workspace(root, path).ok()?;
    let metadata = std::fs::symlink_metadata(&target).ok()?;
    if !metadata.file_type().is_file() || metadata.is_symlink() {
        return None;
    }
    if metadata.len() > max_bytes {
        return None;
    }
    std::fs::read_to_string(&target).ok()
}

/// Snap an Agent-written change into the change set, capturing the live file
/// content as the baseline. The file must exist on disk.
fn capture_baseline_content(root: &Path, task_id: &str, live: &CodingGitFile) -> Result<FileChange, String> {
    let max_bytes: u64 = 8 * 1024 * 1024;
    let baseline = read_bounded(root, &live.path, max_bytes);
    let change = FileChange {
        path: live.path.clone(),
        kind: match live.status.as_str() {
            "added" | "untracked" => ChangeKind::Added,
            "deleted" => ChangeKind::Deleted,
            "renamed" => ChangeKind::Renamed,
            _ => ChangeKind::Modified,
        },
        added: live.added.min(u32::MAX as usize) as u32,
        removed: live.removed.min(u32::MAX as usize) as u32,
        baseline_content: baseline,
        pre_existing: false,
    };
    record_change(root, task_id, change.clone())?;
    Ok(change)
}

/// Snapshot the live Git state and record every file the Agent (or the user
/// during the task) actually changed, relative to the baseline the user
/// captured when the task started.
///
/// Files that were dirty *before* the task are filtered out so a rollback can
/// never destroy the user's own uncommitted work. The derive is best-effort:
/// when `git_snapshot` fails (no Git, network drive, large binary file) we
/// return the existing change set unchanged rather than dropping data.
///
/// `intent-to-add` is set on untracked files so the `git diff` we drive the
/// line counts from sees them. The intent-to-add is reversed when this returns
/// so the working tree is not left with phantom staged files.
pub async fn sync_from_git(root: &Path, task_id: &str) -> Result<ChangeSet, String> {
    use tokio::process::Command;
    if !root.join(".git").exists() && !root.join("../.git").exists() {
        return Ok(load(root, task_id));
    }

    // Best-effort intent-to-add so untracked files appear in `git diff`. We
    // capture the previous state to restore afterwards so the working tree
    // looks the same as before.
    let _ = Command::new("git")
        .args(["add", "-N", "--"])
        .current_dir(root)
        .output()
        .await;

    let snapshot = git_snapshot(root).await;

    // Restore the working tree state before we touch anything else. The
    // snapshot above may have included files that were just made visible
    // by intent-to-add, and those must not appear as staged after we
    // return.
    let result: Result<(), String> = (|| {
        let set = load(root, task_id);
        let prior_by_path: std::collections::HashSet<String> =
            set.changes.iter().map(|c| c.path.clone()).collect();
        let baseline: std::collections::HashSet<String> =
            set.baseline_files.iter().cloned().collect();

        // Capture the live file as a new task change, unless it was already
        // dirty before the task started (then we preserve its pre-existing
        // status by leaving the existing record untouched).
        for live in &snapshot.files {
            if baseline.contains(&live.path) {
                continue;
            }
            if prior_by_path.contains(&live.path) {
                // Re-deriving a path that was already recorded. Refresh its
                // counts so the line totals match the current disk.
                if let Some(existing) = set.changes.iter().find(|c| c.path == live.path).cloned() {
                    let refreshed = FileChange {
                        added: live.added.min(u32::MAX as usize) as u32,
                        removed: live.removed.min(u32::MAX as usize) as u32,
                        baseline_content: existing.baseline_content.clone(),
                        pre_existing: existing.pre_existing,
                        ..existing
                    };
                    record_change(root, task_id, refreshed)?;
                }
                continue;
            }
            capture_baseline_content(root, task_id, live)?;
        }
        Ok(())
    })();

    let _ = Command::new("git")
        .args(["reset", "-N"])
        .current_dir(root)
        .output()
        .await;

    result?;
    Ok(load(root, task_id))
}

#[tauri::command]
pub async fn coding_changeset_sync_from_git(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
) -> Result<ChangeSet, String> {
    let root = access.require_workspace(&root)?;
    sync_from_git(&root, &task_id).await
}

fn restore_one(root: &Path, change: &FileChange) -> Result<(), String> {
    let target = resolve_in_workspace(root, &change.path)?;
    match &change.baseline_content {
        Some(content) => {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| format!("无法创建目录：{error}"))?;
            }
            std::fs::write(&target, content)
                .map_err(|error| format!("还原 {} 失败：{error}", change.path))
        }
        None => {
            if target.exists() {
                std::fs::remove_file(&target)
                    .map_err(|error| format!("删除 {} 失败：{error}", change.path))?;
            }
            Ok(())
        }
    }
}

/// Undo every change this task made, skipping files the user had already
/// modified. Returns the paths that were actually restored or deleted.
pub fn rollback(root: &Path, task_id: &str) -> Result<Vec<String>, String> {
    let mut set = load(root, task_id);
    let mut restored = Vec::new();
    for change in &set.changes {
        if change.pre_existing {
            continue;
        }
        restore_one(root, change)?;
        restored.push(change.path.clone());
    }
    set.changes.retain(|change| change.pre_existing);
    save(root, &set)?;
    Ok(restored)
}

pub fn discard_file(root: &Path, task_id: &str, path: &str) -> Result<ChangeSet, String> {
    let mut set = load(root, task_id);
    let Some(index) = set.changes.iter().position(|change| change.path == path) else {
        return Ok(set);
    };
    if set.changes[index].pre_existing {
        return Err("该文件在任务开始前已有改动，不会被工作台丢弃".into());
    }
    restore_one(root, &set.changes[index])?;
    set.changes.remove(index);
    save(root, &set)?;
    Ok(set)
}

#[tauri::command]
pub async fn coding_changeset_get(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
) -> Result<ChangeSet, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || load(&root, &task_id))
        .await
        .map_err(|error| format!("读取变更集失败：{error}"))
}

#[tauri::command]
pub async fn coding_changeset_capture_baseline(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
    dirty_files: Vec<String>,
) -> Result<ChangeSet, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || capture_baseline(&root, &task_id, dirty_files))
        .await
        .map_err(|error| format!("记录基线失败：{error}"))?
}

#[tauri::command]
pub async fn coding_changeset_discard_file(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
    path: String,
) -> Result<ChangeSet, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || discard_file(&root, &task_id, &path))
        .await
        .map_err(|error| format!("丢弃文件改动失败：{error}"))?
}

/// Record one file the Agent (or the user's own editor) just changed. The
/// frontend calls this as edits land so the change set stays authoritative
/// without polling Git.
#[tauri::command]
pub async fn coding_changeset_record_change(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
    change: FileChange,
) -> Result<ChangeSet, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || record_change(&root, &task_id, change))
        .await
        .map_err(|error| format!("记录文件变更失败：{error}"))?
}

#[tauri::command]
pub async fn coding_changeset_mark_reviewed(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
    path: String,
) -> Result<ChangeSet, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || mark_reviewed(&root, &task_id, &path))
        .await
        .map_err(|error| format!("标记已审阅失败：{error}"))?
}

#[tauri::command]
pub async fn coding_task_rollback(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
) -> Result<Vec<String>, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || rollback(&root, &task_id))
        .await
        .map_err(|error| format!("回滚任务失败：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("coding-cs-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn records_changes_and_accumulates_line_counts() {
        let root = temp_root();
        record_change(
            &root,
            "task-1",
            FileChange {
                path: "src/a.ts".into(),
                kind: ChangeKind::Modified,
                added: 10,
                removed: 2,
                baseline_content: Some("old".into()),
                pre_existing: false,
            },
        )
        .unwrap();
        let set = record_change(
            &root,
            "task-1",
            FileChange {
                path: "src/b.ts".into(),
                kind: ChangeKind::Added,
                added: 30,
                removed: 0,
                baseline_content: None,
                pre_existing: false,
            },
        )
        .unwrap();
        assert_eq!(set.changes.len(), 2);
        assert_eq!(set.total_added(), 40);
        assert_eq!(set.total_removed(), 2);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn re_recording_same_file_replaces_not_duplicates() {
        let root = temp_root();
        record_change(
            &root,
            "task-1",
            FileChange {
                path: "src/a.ts".into(),
                kind: ChangeKind::Modified,
                added: 5,
                removed: 1,
                baseline_content: Some("v1".into()),
                pre_existing: false,
            },
        )
        .unwrap();
        let set = record_change(
            &root,
            "task-1",
            FileChange {
                path: "src/a.ts".into(),
                kind: ChangeKind::Modified,
                added: 8,
                removed: 3,
                baseline_content: Some("should-not-overwrite".into()),
                pre_existing: false,
            },
        )
        .unwrap();
        assert_eq!(set.changes.len(), 1);
        assert_eq!(set.changes[0].added, 8);
        // The first baseline must win; it is the only content that can restore
        // the file to its pre-task state.
        assert_eq!(set.changes[0].baseline_content.as_deref(), Some("v1"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rollback_restores_modified_deletes_added_and_skips_user_changes() {
        let root = temp_root();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/modified.ts"), "agent version").unwrap();
        std::fs::write(root.join("src/created.ts"), "agent created").unwrap();
        std::fs::write(root.join("src/user.ts"), "user edited").unwrap();

        for change in [
            FileChange {
                path: "src/modified.ts".into(),
                kind: ChangeKind::Modified,
                added: 1,
                removed: 1,
                baseline_content: Some("original version".into()),
                pre_existing: false,
            },
            FileChange {
                path: "src/created.ts".into(),
                kind: ChangeKind::Added,
                added: 1,
                removed: 0,
                baseline_content: None,
                pre_existing: false,
            },
            FileChange {
                path: "src/user.ts".into(),
                kind: ChangeKind::Modified,
                added: 1,
                removed: 0,
                baseline_content: Some("never restore this".into()),
                pre_existing: true,
            },
        ] {
            record_change(&root, "task-1", change).unwrap();
        }

        let restored = rollback(&root, "task-1").unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("src/modified.ts")).unwrap(),
            "original version"
        );
        assert!(!root.join("src/created.ts").exists());
        // A pre-existing user change is never touched by task rollback.
        assert_eq!(
            std::fs::read_to_string(root.join("src/user.ts")).unwrap(),
            "user edited"
        );
        assert_eq!(restored.len(), 2);
        assert!(load(&root, "task-1")
            .changes
            .iter()
            .all(|change| change.pre_existing));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn baseline_marks_pre_existing_dirty_files() {
        let root = temp_root();
        let set = capture_baseline(
            &root,
            "task-1",
            vec!["src/dirty.ts".to_string(), "src/other.ts".to_string()],
        )
        .unwrap();
        assert_eq!(set.baseline_files.len(), 2);
        assert!(set.is_pre_existing("src/dirty.ts"));
        assert!(!set.is_pre_existing("src/fresh.ts"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn mark_reviewed_is_idempotent() {
        let root = temp_root();
        mark_reviewed(&root, "task-1", "src/a.ts").unwrap();
        let set = mark_reviewed(&root, "task-1", "src/a.ts").unwrap();
        assert_eq!(set.reviewed_files, vec!["src/a.ts".to_string()]);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn discard_file_restores_one_file_and_drops_its_record() {
        let root = temp_root();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/a.ts"), "agent").unwrap();
        record_change(
            &root,
            "task-1",
            FileChange {
                path: "src/a.ts".into(),
                kind: ChangeKind::Modified,
                added: 1,
                removed: 1,
                baseline_content: Some("original".into()),
                pre_existing: false,
            },
        )
        .unwrap();
        let set = discard_file(&root, "task-1", "src/a.ts").unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("src/a.ts")).unwrap(),
            "original"
        );
        assert!(set.changes.is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn sync_from_git_captures_untracked_files_as_added() {
        let root = temp_root();
        // Need a real git repo for `git diff --numstat` to show untracked files.
        let _ = std::process::Command::new("git")
            .args(["init", "--initial-branch=main"])
            .current_dir(&root)
            .output();
        let _ = std::process::Command::new("git")
            .args(["config", "user.email", "t@t"])
            .current_dir(&root)
            .output();
        let _ = std::process::Command::new("git")
            .args(["config", "user.name", "t"])
            .current_dir(&root)
            .output();
        // Create a baseline file and commit it so the repo is not empty.
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/seed.ts"), "seed\n").unwrap();
        let _ = std::process::Command::new("git")
            .args(["add", "."])
            .current_dir(&root)
            .output();
        let _ = std::process::Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(&root)
            .output();

        // User's pre-existing dirty edit — must stay protected.
        std::fs::write(root.join("src/seed.ts"), "seed\nuser-edit\n").unwrap();
        capture_baseline(&root, "task-1", vec!["src/seed.ts".to_string()]).map_err(|e| {
            eprintln!("baseline error: {e}");
            e
        }).unwrap();

        // The Agent creates a new file and edits an existing tracked file.
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/new.ts"), "export const x = 1;\n").unwrap();
        std::fs::write(root.join("src/seed.ts"), "seed\nagent-edit\n").unwrap();

        let set = sync_from_git(&root, "task-1").await.unwrap();
        let paths: Vec<&str> = set.changes.iter().map(|c| c.path.as_str()).collect();
        // The untracked new file must appear as a task change.
        assert!(
            paths.contains(&"src/new.ts"),
            "new file must appear: {paths:?}"
        );
        // The dirty tracked file stays in baseline_files (protected), not in
        // the task's changes — the Agent's edits live on top of the user's
        // existing work without claiming it as a task outcome.
        assert!(
            !paths.contains(&"src/seed.ts"),
            "pre-existing dirty file must stay out of task changes: {paths:?}"
        );
        assert_eq!(
            set.baseline_files,
            vec!["src/seed.ts".to_string()],
            "the user's dirty file is the baseline"
        );

        // Intent-to-add must be reversed: the new file is not staged.
        let staged = std::process::Command::new("git")
            .args(["diff", "--cached", "--name-only"])
            .current_dir(&root)
            .output()
            .unwrap();
        let staged_stdout = String::from_utf8_lossy(&staged.stdout).to_string();
        assert!(!staged_stdout.contains("src/new.ts"), "untracked file must not be staged after sync, got:\n{staged_stdout}");

        std::fs::remove_dir_all(&root).ok();
    }
}
