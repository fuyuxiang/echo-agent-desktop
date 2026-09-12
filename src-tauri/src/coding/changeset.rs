//! Per-task change set. Records every file the Agent touched together with the
//! content it had before the task started, which is what makes a one-click
//! task rollback possible without reaching for Git history.
//!
//! Files already dirty at task start are snapshotted byte-for-byte and marked
//! `pre_existing`, so rollback restores the user's exact starting content rather
//! than overwriting it with Git HEAD or silently ignoring Agent changes on top.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

use crate::coding_workspace::{git_snapshot, CodingGitFile};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;

use crate::coding::store;
use crate::coding::task::{self, TaskNodeStatus, TaskPhase};
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

/// Exact working-tree state at task start. Bytes are base64 encoded so binary
/// files can be restored without conflating "not UTF-8" with "did not exist".
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BaselineFile {
    pub path: String,
    pub existed: bool,
    pub content_base64: Option<String>,
    pub hash: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSet {
    pub task_id: String,
    /// Paths that were dirty before the task started.
    pub baseline_files: Vec<String>,
    /// Commit the working tree was based on when the task began. A changed HEAD
    /// invalidates automatic rollback/commit rather than guessing across history.
    #[serde(default)]
    pub baseline_head: Option<String>,
    /// Dirty files are captured at task start; clean files are added lazily from
    /// `baseline_head` the first time the task changes them.
    #[serde(default)]
    pub baseline_entries: Vec<BaselineFile>,
    pub changes: Vec<FileChange>,
    pub created_at: String,
    /// Paths whose diff the user actually opened. The diff-review quality gate
    /// needs evidence of review, not merely the existence of a change.
    #[serde(default)]
    pub reviewed_files: Vec<String>,
    /// Review evidence is tied to file content and is invalidated on any write.
    #[serde(default)]
    pub reviewed_hashes: BTreeMap<String, String>,
    /// Current content hashes for task changes.
    #[serde(default)]
    pub change_hashes: BTreeMap<String, String>,
    /// Files that exceeded the snapshot bound or could not be read safely.
    #[serde(default)]
    pub rollback_unsafe_files: Vec<String>,
    /// Preserves delivery evidence while preventing duplicate commits.
    #[serde(default)]
    pub committed_hash: Option<String>,
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

    pub fn is_reviewed(&self, path: &str) -> bool {
        self.change_hashes
            .get(path)
            .zip(self.reviewed_hashes.get(path))
            .is_some_and(|(current, reviewed)| current == reviewed)
    }
}

fn changeset_path(root: &Path, task_id: &str) -> PathBuf {
    store::task_dir(root, task_id).join("changeset.json")
}

pub fn load(root: &Path, task_id: &str) -> ChangeSet {
    store::read_json(&changeset_path(root, task_id)).unwrap_or_else(|| ChangeSet {
        task_id: task_id.to_string(),
        baseline_files: Vec::new(),
        baseline_head: None,
        baseline_entries: Vec::new(),
        changes: Vec::new(),
        created_at: chrono::Utc::now().to_rfc3339(),
        reviewed_files: Vec::new(),
        reviewed_hashes: BTreeMap::new(),
        change_hashes: BTreeMap::new(),
        rollback_unsafe_files: Vec::new(),
        committed_hash: None,
    })
}

fn save(root: &Path, set: &ChangeSet) -> Result<(), String> {
    store::write_json(&changeset_path(root, &set.task_id), set)
}

/// Reject paths that try to escape the workspace before any write or delete.
fn resolve_in_workspace(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let normalized = relative.replace('\\', "/");
    if normalized.is_empty() || normalized.contains('\0') {
        return Err(format!("非法的工作区路径：{relative}"));
    }
    let mut safe = PathBuf::new();
    for component in Path::new(&normalized).components() {
        match component {
            Component::Normal(part) => safe.push(part),
            // Absolute paths, `..`, platform prefixes and ambiguous `.`
            // components must never reach a restore/read operation.
            _ => return Err(format!("非法的工作区路径：{relative}")),
        }
    }
    if safe.as_os_str().is_empty() {
        return Err(format!("非法的工作区路径：{relative}"));
    }
    Ok(root.join(safe))
}

/// Refuse to traverse a symlinked directory. A lexical `root.join(path)` check
/// alone is insufficient because an Agent could replace a parent directory
/// with a link pointing outside the workspace before rollback.
fn ensure_safe_parent_chain(
    root: &Path,
    target: &Path,
    create_missing: bool,
) -> Result<(), String> {
    let relative = target
        .strip_prefix(root)
        .map_err(|_| "文件路径不在工作区内".to_string())?;
    let mut current = root.to_path_buf();
    let Some(parent) = relative.parent() else {
        return Ok(());
    };
    for component in parent.components() {
        let Component::Normal(part) = component else {
            return Err("文件路径包含不安全目录分量".into());
        };
        current.push(part);
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "{} 是符号链接，为避免越出工作区已停止操作",
                    current.display()
                ));
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Err(format!("{} 不是目录", current.display()));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && create_missing => {
                std::fs::create_dir(&current)
                    .map_err(|error| format!("无法创建目录 {}：{error}", current.display()))?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => {
                return Err(format!("无法检查目录 {}：{error}", current.display()));
            }
        }
    }
    Ok(())
}

const MAX_BASELINE_BYTES: usize = 16 * 1024 * 1024;

fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn git_head(root: &Path) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(root)
        .output()
        .map_err(|error| format!("无法读取 Git HEAD：{error}"))?;
    if !output.status.success() {
        return Err("代码开发任务需要一个已初始化且至少有一次提交的 Git 仓库".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn read_workspace_bytes(root: &Path, path: &str) -> Result<Option<Vec<u8>>, String> {
    let target = resolve_in_workspace(root, path)?;
    ensure_safe_parent_chain(root, &target, false)?;
    let metadata = match std::fs::symlink_metadata(&target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法读取 {path} 的元数据：{error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("{path} 不是可安全快照的普通文件"));
    }
    if metadata.len() > MAX_BASELINE_BYTES as u64 {
        return Err(format!("{path} 超过 16 MB，无法建立安全回滚快照"));
    }
    std::fs::read(&target)
        .map(Some)
        .map_err(|error| format!("读取 {path} 失败：{error}"))
}

fn baseline_from_worktree(root: &Path, path: &str) -> Result<BaselineFile, String> {
    let bytes = read_workspace_bytes(root, path)?;
    Ok(match bytes {
        Some(bytes) => BaselineFile {
            path: path.to_string(),
            existed: true,
            hash: Some(hash_bytes(&bytes)),
            content_base64: Some(STANDARD.encode(bytes)),
        },
        None => BaselineFile {
            path: path.to_string(),
            existed: false,
            hash: None,
            content_base64: None,
        },
    })
}

pub fn capture_baseline(
    root: &Path,
    task_id: &str,
    mut dirty_files: Vec<String>,
) -> Result<ChangeSet, String> {
    let mut set = load(root, task_id);
    if !set.changes.is_empty() {
        return Err("任务已经产生变更，不能重写开始基线".into());
    }
    dirty_files.sort();
    dirty_files.dedup();
    let entries = dirty_files
        .iter()
        .map(|path| baseline_from_worktree(root, path))
        .collect::<Result<Vec<_>, _>>()?;
    set.baseline_head = Some(git_head(root)?);
    set.baseline_files = dirty_files;
    set.baseline_entries = entries;
    set.reviewed_files.clear();
    set.reviewed_hashes.clear();
    set.change_hashes.clear();
    set.rollback_unsafe_files.clear();
    set.committed_hash = None;
    save(root, &set)?;
    Ok(set)
}

/// Record one file change. Re-recording the same path replaces its counters but
/// keeps the first baseline content, because only that snapshot can restore the
/// file to its pre-task state.
pub fn record_change(root: &Path, task_id: &str, change: FileChange) -> Result<ChangeSet, String> {
    let mut set = load(root, task_id);
    let pre_existing = change.pre_existing || set.is_pre_existing(&change.path);
    if !set
        .baseline_entries
        .iter()
        .any(|entry| entry.path == change.path)
    {
        let baseline_bytes = change.baseline_content.as_deref().map(str::as_bytes);
        set.baseline_entries.push(BaselineFile {
            path: change.path.clone(),
            existed: baseline_bytes.is_some(),
            content_base64: baseline_bytes.map(|bytes| STANDARD.encode(bytes)),
            hash: baseline_bytes.map(hash_bytes),
        });
    }
    let current_hash = read_workspace_bytes(root, &change.path)?
        .as_deref()
        .map(hash_bytes)
        .unwrap_or_else(|| "<deleted>".into());
    set.change_hashes.insert(change.path.clone(), current_hash);
    set.reviewed_hashes.remove(&change.path);
    set.reviewed_files.retain(|path| path != &change.path);
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
    if !set.changes.iter().any(|change| change.path == path) {
        return Err("该文件不在当前任务变更集中".into());
    }
    let hash = set
        .change_hashes
        .get(path)
        .cloned()
        .ok_or_else(|| "无法确认该差异的内容版本".to_string())?;
    set.reviewed_hashes.insert(path.to_string(), hash);
    set.reviewed_files = set.reviewed_hashes.keys().cloned().collect();
    save(root, &set)?;
    Ok(set)
}

async fn current_head(root: &Path) -> Result<String, String> {
    let output = tokio::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(root)
        .output()
        .await
        .map_err(|error| format!("无法读取 Git HEAD：{error}"))?;
    if !output.status.success() {
        return Err("当前工作区不是可用的 Git 仓库".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn text_line_count(bytes: &[u8]) -> usize {
    std::str::from_utf8(bytes)
        .map(|text| text.lines().count())
        .unwrap_or_default()
}

/// Compute task-baseline-relative line totals with Git's own diff engine. The
/// repository-wide numstat is HEAD-relative and is wrong for files that were
/// already dirty when the task began.
async fn line_delta(baseline: Option<&[u8]>, current: Option<&[u8]>) -> (usize, usize) {
    match (baseline, current) {
        (None, Some(bytes)) => return (text_line_count(bytes), 0),
        (Some(bytes), None) => return (0, text_line_count(bytes)),
        (None, None) => return (0, 0),
        _ => {}
    }
    let baseline = baseline.unwrap_or_default();
    let current = current.unwrap_or_default();
    if std::str::from_utf8(baseline).is_err() || std::str::from_utf8(current).is_err() {
        return (0, 0);
    }
    let temp = std::env::temp_dir().join(format!("echo-code-diff-{}", uuid::Uuid::now_v7()));
    if tokio::fs::create_dir(&temp).await.is_err() {
        return (text_line_count(current), text_line_count(baseline));
    }
    let before = temp.join("before");
    let after = temp.join("after");
    let result = async {
        tokio::fs::write(&before, baseline).await.ok()?;
        tokio::fs::write(&after, current).await.ok()?;
        let output = tokio::process::Command::new("git")
            .args(["diff", "--no-index", "--numstat", "--"])
            .arg(&before)
            .arg(&after)
            .output()
            .await
            .ok()?;
        // `git diff --no-index` returns 1 when differences were found.
        if !output.status.success() && output.status.code() != Some(1) {
            return None;
        }
        let line = String::from_utf8_lossy(&output.stdout);
        let mut columns = line.split('\t');
        let added = columns.next()?.trim().parse().ok()?;
        let removed = columns.next()?.trim().parse().ok()?;
        Some((added, removed))
    }
    .await;
    let _ = tokio::fs::remove_dir_all(&temp).await;
    result.unwrap_or_else(|| (text_line_count(current), text_line_count(baseline)))
}

async fn read_workspace_bytes_async(root: &Path, path: &str) -> Result<Option<Vec<u8>>, String> {
    let target = resolve_in_workspace(root, path)?;
    ensure_safe_parent_chain(root, &target, false)?;
    let metadata = match tokio::fs::symlink_metadata(&target).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法读取 {path} 的元数据：{error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("{path} 不是可安全回滚的普通文件"));
    }
    if metadata.len() > MAX_BASELINE_BYTES as u64 {
        return Err(format!("{path} 超过 16 MB 安全快照上限"));
    }
    tokio::fs::read(&target)
        .await
        .map(Some)
        .map_err(|error| format!("读取 {path} 失败：{error}"))
}

async fn baseline_from_git(
    root: &Path,
    head: &str,
    live: &CodingGitFile,
) -> Result<BaselineFile, String> {
    if matches!(live.status.as_str(), "added" | "untracked") {
        return Ok(BaselineFile {
            path: live.path.clone(),
            existed: false,
            content_base64: None,
            hash: None,
        });
    }
    let spec = format!("{head}:{}", live.path);
    let output = tokio::process::Command::new("git")
        .args(["show", "--no-ext-diff", &spec])
        .current_dir(root)
        .output()
        .await
        .map_err(|error| format!("读取 {} 的 Git 基线失败：{error}", live.path))?;
    if !output.status.success() {
        return Err(format!("无法从任务基线恢复 {}，已禁止自动回滚", live.path));
    }
    if output.stdout.len() > MAX_BASELINE_BYTES {
        return Err(format!("{} 超过 16 MB 安全快照上限", live.path));
    }
    Ok(BaselineFile {
        path: live.path.clone(),
        existed: true,
        hash: Some(hash_bytes(&output.stdout)),
        content_base64: Some(STANDARD.encode(output.stdout)),
    })
}

/// Snapshot the live Git state and record every file the Agent (or the user
/// during the task) actually changed, relative to the baseline the user
/// captured when the task started.
///
/// Dirty-at-start files remain included when the task changes their contents;
/// the persisted byte snapshot protects the user's work during rollback.
pub async fn sync_from_git(root: &Path, task_id: &str) -> Result<ChangeSet, String> {
    let snapshot = git_snapshot(root).await;
    if !snapshot.has_git {
        return Err("为了保证变更归属和可回滚性，代码开发任务仅支持 Git 仓库".into());
    }
    let mut set = load(root, task_id);
    if set.committed_hash.is_some() {
        return Ok(set);
    }
    let baseline_head = set
        .baseline_head
        .clone()
        .ok_or_else(|| "任务缺少安全基线，请新建任务后重试".to_string())?;
    let head = current_head(root).await?;
    if head != baseline_head {
        return Err("任务执行期间 Git HEAD 已改变，为避免覆盖新提交，已停止自动同步".into());
    }

    let mut entries: BTreeMap<String, BaselineFile> = set
        .baseline_entries
        .iter()
        .cloned()
        .map(|entry| (entry.path.clone(), entry))
        .collect();
    let mut changes = Vec::new();
    let mut hashes = BTreeMap::new();
    let mut unsafe_files = Vec::new();

    for live in &snapshot.files {
        let current = match read_workspace_bytes_async(root, &live.path).await {
            Ok(bytes) => bytes,
            Err(_) => {
                unsafe_files.push(live.path.clone());
                None
            }
        };
        let baseline = if let Some(existing) = entries.get(&live.path) {
            existing.clone()
        } else {
            match baseline_from_git(root, &baseline_head, live).await {
                Ok(entry) => {
                    entries.insert(live.path.clone(), entry.clone());
                    entry
                }
                Err(_) => {
                    unsafe_files.push(live.path.clone());
                    BaselineFile {
                        path: live.path.clone(),
                        existed: !matches!(live.status.as_str(), "added" | "untracked"),
                        content_base64: None,
                        hash: None,
                    }
                }
            }
        };
        let current_hash = current.as_deref().map(hash_bytes);
        let unchanged = baseline.existed == current.is_some() && baseline.hash == current_hash;
        if unchanged {
            continue;
        }
        let hash = current_hash.unwrap_or_else(|| "<deleted>".into());
        hashes.insert(live.path.clone(), hash);
        let baseline_bytes = baseline
            .content_base64
            .as_deref()
            .and_then(|content| STANDARD.decode(content).ok());
        let baseline_content = baseline_bytes
            .as_deref()
            .and_then(|bytes| std::str::from_utf8(bytes).ok())
            .map(str::to_string);
        let (added, removed) = line_delta(baseline_bytes.as_deref(), current.as_deref()).await;
        changes.push(FileChange {
            path: live.path.clone(),
            kind: match live.status.as_str() {
                "added" | "untracked" => ChangeKind::Added,
                "deleted" => ChangeKind::Deleted,
                "renamed" => ChangeKind::Renamed,
                _ => ChangeKind::Modified,
            },
            added: added.min(u32::MAX as usize) as u32,
            removed: removed.min(u32::MAX as usize) as u32,
            baseline_content,
            pre_existing: set.is_pre_existing(&live.path),
        });
    }

    // A pre-existing dirty file can disappear from `git status` if the Agent
    // overwrites it with HEAD, and a pre-existing untracked file can disappear
    // after deletion. Compare every persisted baseline too; otherwise those two
    // destructive outcomes would be invisible and impossible to review/restore.
    let live_paths: BTreeSet<&str> = snapshot
        .files
        .iter()
        .map(|file| file.path.as_str())
        .collect();
    for baseline in entries.values() {
        if live_paths.contains(baseline.path.as_str()) {
            continue;
        }
        let current = match read_workspace_bytes_async(root, &baseline.path).await {
            Ok(bytes) => bytes,
            Err(_) => {
                unsafe_files.push(baseline.path.clone());
                continue;
            }
        };
        let current_hash = current.as_deref().map(hash_bytes);
        if baseline.existed == current.is_some() && baseline.hash == current_hash {
            continue;
        }
        hashes.insert(
            baseline.path.clone(),
            current_hash.unwrap_or_else(|| "<deleted>".into()),
        );
        let baseline_bytes = baseline
            .content_base64
            .as_deref()
            .and_then(|content| STANDARD.decode(content).ok());
        let baseline_text = baseline_bytes
            .as_deref()
            .and_then(|bytes| std::str::from_utf8(bytes).ok())
            .map(str::to_string);
        let (added, removed) = line_delta(baseline_bytes.as_deref(), current.as_deref()).await;
        changes.push(FileChange {
            path: baseline.path.clone(),
            kind: match (baseline.existed, current.is_some()) {
                (false, true) => ChangeKind::Added,
                (true, false) => ChangeKind::Deleted,
                _ => ChangeKind::Modified,
            },
            added: added.min(u32::MAX as usize) as u32,
            removed: removed.min(u32::MAX as usize) as u32,
            baseline_content: baseline_text,
            pre_existing: set.is_pre_existing(&baseline.path),
        });
    }

    changes.sort_by(|left, right| left.path.cmp(&right.path));
    unsafe_files.sort();
    unsafe_files.dedup();

    set.baseline_entries = entries.into_values().collect();
    set.changes = changes;
    set.change_hashes = hashes;
    set.rollback_unsafe_files = unsafe_files;
    set.reviewed_hashes.retain(|path, reviewed_hash| {
        set.change_hashes
            .get(path)
            .is_some_and(|current_hash| current_hash == reviewed_hash)
    });
    set.reviewed_files = set.reviewed_hashes.keys().cloned().collect();
    let stored = set.clone();
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || save(&root, &stored))
        .await
        .map_err(|error| format!("保存变更集失败：{error}"))??;
    Ok(set)
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

fn restore_one(root: &Path, baseline: &BaselineFile) -> Result<(), String> {
    let target = resolve_in_workspace(root, &baseline.path)?;
    ensure_safe_parent_chain(root, &target, baseline.existed)?;
    if baseline.existed {
        let encoded = baseline
            .content_base64
            .as_deref()
            .ok_or_else(|| format!("{} 缺少可回滚快照", baseline.path))?;
        let content = STANDARD
            .decode(encoded)
            .map_err(|error| format!("解码 {} 的回滚快照失败：{error}", baseline.path))?;
        match std::fs::symlink_metadata(&target) {
            Ok(metadata) if metadata.is_dir() => {
                return Err(format!(
                    "{} 已变成目录，为避免误删已停止回滚",
                    baseline.path
                ));
            }
            Ok(metadata) if metadata.file_type().is_symlink() => {
                // Remove the link itself; never follow it while restoring.
                std::fs::remove_file(&target)
                    .map_err(|error| format!("移除 {} 的符号链接失败：{error}", baseline.path))?;
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("无法检查 {}：{error}", baseline.path)),
        }
        std::fs::write(&target, content)
            .map_err(|error| format!("还原 {} 失败：{error}", baseline.path))
    } else {
        match std::fs::symlink_metadata(&target) {
            Ok(metadata) => {
                if metadata.is_dir() {
                    return Err(format!(
                        "{} 已变成目录，为避免误删已停止回滚",
                        baseline.path
                    ));
                }
                // `symlink_metadata` also sees dangling links, which
                // `Path::exists` misses.
                std::fs::remove_file(&target)
                    .map_err(|error| format!("删除 {} 失败：{error}", baseline.path))?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!("无法检查 {} 是否需要删除：{error}", baseline.path,));
            }
        }
        Ok(())
    }
}

pub fn ensure_head_unchanged(root: &Path, set: &ChangeSet) -> Result<(), String> {
    let baseline = set
        .baseline_head
        .as_deref()
        .ok_or_else(|| "任务缺少安全基线".to_string())?;
    if git_head(root)? != baseline {
        return Err("任务期间 Git HEAD 已变更，自动回滚已停止，请手工检查差异".into());
    }
    Ok(())
}

fn baseline_for<'a>(set: &'a ChangeSet, path: &str) -> Result<&'a BaselineFile, String> {
    set.baseline_entries
        .iter()
        .find(|entry| entry.path == path)
        .ok_or_else(|| format!("{path} 缺少任务前快照，已停止破坏性操作"))
}

/// Restore every task-related file to its exact task-start content. Returns the
/// paths that were restored or deleted.
pub fn rollback(root: &Path, task_id: &str) -> Result<Vec<String>, String> {
    let mut set = load(root, task_id);
    if set.committed_hash.is_some() {
        return Err("任务已提交，请使用 Git revert 创建可审计的逆向提交".into());
    }
    ensure_head_unchanged(root, &set)?;
    if !set.rollback_unsafe_files.is_empty() {
        return Err(format!(
            "以下文件没有安全快照，为避免数据丢失已取消整体回滚：{}",
            set.rollback_unsafe_files.join("、")
        ));
    }
    // Preflight every snapshot before touching the working tree, preventing a
    // half-applied rollback if persisted metadata is incomplete.
    for change in &set.changes {
        let baseline = baseline_for(&set, &change.path)?;
        if baseline.existed && baseline.content_base64.is_none() {
            return Err(format!("{} 缺少回滚内容", change.path));
        }
    }
    let mut restored = Vec::new();
    for change in &set.changes {
        restore_one(root, baseline_for(&set, &change.path)?)?;
        restored.push(change.path.clone());
    }
    set.changes.clear();
    set.change_hashes.clear();
    set.reviewed_hashes.clear();
    set.reviewed_files.clear();
    save(root, &set)?;
    Ok(restored)
}

pub fn discard_file(root: &Path, task_id: &str, path: &str) -> Result<ChangeSet, String> {
    let mut set = load(root, task_id);
    if set.committed_hash.is_some() {
        return Err("任务已提交，不能再丢弃文件".into());
    }
    ensure_head_unchanged(root, &set)?;
    let Some(index) = set.changes.iter().position(|change| change.path == path) else {
        return Ok(set);
    };
    if set.rollback_unsafe_files.iter().any(|entry| entry == path) {
        return Err("该文件没有安全快照，已拒绝丢弃".into());
    }
    restore_one(root, baseline_for(&set, path)?)?;
    set.changes.remove(index);
    set.change_hashes.remove(path);
    set.reviewed_hashes.remove(path);
    set.reviewed_files.retain(|entry| entry != path);
    save(root, &set)?;
    Ok(set)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChangeDiff {
    pub original: String,
    pub modified: String,
    pub binary: bool,
}

pub fn change_diff(root: &Path, task_id: &str, path: &str) -> Result<ChangeDiff, String> {
    let set = load(root, task_id);
    if !set.changes.iter().any(|change| change.path == path) {
        return Err("该文件不在当前任务变更集中".into());
    }
    let baseline = baseline_for(&set, path)?;
    let original_bytes = if baseline.existed {
        STANDARD
            .decode(
                baseline
                    .content_base64
                    .as_deref()
                    .ok_or_else(|| format!("{path} 缺少任务前快照"))?,
            )
            .map_err(|error| format!("解码 {path} 的任务前快照失败：{error}"))?
    } else {
        Vec::new()
    };
    let modified_bytes = read_workspace_bytes(root, path)?.unwrap_or_default();
    let original = String::from_utf8(original_bytes);
    let modified = String::from_utf8(modified_bytes);
    match (original, modified) {
        (Ok(original), Ok(modified)) => Ok(ChangeDiff {
            original,
            modified,
            binary: false,
        }),
        _ => Ok(ChangeDiff {
            original: "二进制文件：不显示文本差异".into(),
            modified: "二进制文件：请使用专用工具审阅".into(),
            binary: true,
        }),
    }
}

pub fn mark_committed(root: &Path, task_id: &str, hash: &str) -> Result<ChangeSet, String> {
    let mut set = load(root, task_id);
    set.committed_hash = Some(hash.to_string());
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
    let snapshot = git_snapshot(&root).await;
    if !snapshot.has_git {
        return Err("为了保证变更可审计、可回滚，代码开发任务需要 Git 仓库".into());
    }
    // Never trust a renderer-provided dirty-file list for a safety boundary.
    // It remains in the wire contract for backward compatibility only.
    let _ = dirty_files;
    let actual_dirty = snapshot.files.into_iter().map(|file| file.path).collect();
    tokio::task::spawn_blocking(move || capture_baseline(&root, &task_id, actual_dirty))
        .await
        .map_err(|error| format!("记录基线失败：{error}"))?
}

#[tauri::command]
pub async fn coding_changeset_diff(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
    path: String,
) -> Result<ChangeDiff, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || change_diff(&root, &task_id, &path))
        .await
        .map_err(|error| format!("读取任务差异失败：{error}"))?
}

#[tauri::command]
pub async fn coding_changeset_discard_file(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
    path: String,
) -> Result<ChangeSet, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || {
        let coding_task = task::load(&root, &task_id).ok_or_else(|| "任务不存在".to_string())?;
        if !matches!(
            coding_task.phase,
            TaskPhase::Implementing | TaskPhase::Repairing
        ) {
            return Err("请先将任务重新进入实现阶段，再丢弃文件改动".into());
        }
        discard_file(&root, &task_id, &path)
    })
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
    tokio::task::spawn_blocking(move || {
        let current = task::load(&root, &task_id).ok_or_else(|| "任务不存在".to_string())?;
        if !matches!(
            current.phase,
            TaskPhase::Gating | TaskPhase::Delivered | TaskPhase::Blocked
        ) {
            return Err("任务正在执行或验证，请先停止后再回滚".into());
        }
        let restored = rollback(&root, &task_id)?;
        if let Some(mut coding_task) = task::load(&root, &task_id) {
            coding_task.phase = TaskPhase::Blocked;
            coding_task.phase_reason = Some("任务已回滚".into());
            coding_task.blocker = Some("任务文件已恢复到开始时的状态。".into());
            for node in &mut coding_task.task_nodes {
                node.status = TaskNodeStatus::Blocked;
            }
            task::save(&root, &coding_task)?;
        }
        Ok(restored)
    })
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

    fn init_git(root: &Path, files: &[(&str, &str)]) {
        std::process::Command::new("git")
            .args(["init", "--initial-branch=main"])
            .current_dir(root)
            .output()
            .unwrap();
        for (path, content) in files {
            let target = root.join(path);
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
            std::fs::write(target, content).unwrap();
        }
        for args in [
            &["config", "user.email", "t@t"][..],
            &["config", "user.name", "t"][..],
            &["add", "."][..],
            &["commit", "-m", "init"][..],
        ] {
            let output = std::process::Command::new("git")
                .args(args)
                .current_dir(root)
                .output()
                .unwrap();
            assert!(output.status.success(), "git command failed: {args:?}");
        }
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
    fn workspace_path_validation_rejects_traversal_but_allows_dotted_names() {
        let root = temp_root();
        assert!(resolve_in_workspace(&root, "../outside").is_err());
        assert!(resolve_in_workspace(&root, "/outside").is_err());
        assert_eq!(
            resolve_in_workspace(&root, "src/range..test.ts").unwrap(),
            root.join("src/range..test.ts")
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn restore_never_follows_a_symlink_outside_the_workspace() {
        use std::os::unix::fs::symlink;

        let root = temp_root();
        let outside = temp_root();
        std::fs::write(outside.join("victim.txt"), "outside").unwrap();
        symlink(&outside, root.join("linked")).unwrap();
        let baseline = BaselineFile {
            path: "linked/victim.txt".into(),
            existed: true,
            content_base64: Some(STANDARD.encode("baseline")),
            hash: Some(hash_bytes(b"baseline")),
        };

        assert!(restore_one(&root, &baseline).is_err());
        assert_eq!(
            std::fs::read_to_string(outside.join("victim.txt")).unwrap(),
            "outside"
        );
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    #[cfg(unix)]
    #[test]
    fn rollback_removes_a_dangling_link_created_by_the_task() {
        use std::os::unix::fs::symlink;

        let root = temp_root();
        symlink(root.join("missing-target"), root.join("created-link")).unwrap();
        let baseline = BaselineFile {
            path: "created-link".into(),
            existed: false,
            content_base64: None,
            hash: None,
        };

        restore_one(&root, &baseline).unwrap();
        assert!(std::fs::symlink_metadata(root.join("created-link")).is_err());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rollback_restores_exact_task_start_state_including_dirty_files() {
        let root = temp_root();
        init_git(
            &root,
            &[
                ("src/modified.ts", "original version"),
                ("src/user.ts", "head"),
            ],
        );
        std::fs::write(root.join("src/user.ts"), "user edited").unwrap();
        capture_baseline(&root, "task-1", vec!["src/user.ts".into()]).unwrap();

        std::fs::write(root.join("src/modified.ts"), "agent version").unwrap();
        std::fs::write(root.join("src/created.ts"), "agent created").unwrap();
        std::fs::write(root.join("src/user.ts"), "agent replaced user work").unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(sync_from_git(&root, "task-1")).unwrap();

        let restored = rollback(&root, "task-1").unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("src/modified.ts")).unwrap(),
            "original version"
        );
        assert!(!root.join("src/created.ts").exists());
        // The user's exact task-start content, rather than HEAD, is restored.
        assert_eq!(
            std::fs::read_to_string(root.join("src/user.ts")).unwrap(),
            "user edited"
        );
        assert_eq!(restored.len(), 3);
        assert!(load(&root, "task-1").changes.is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn baseline_marks_pre_existing_dirty_files() {
        let root = temp_root();
        init_git(&root, &[("README.md", "seed")]);
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
        record_change(
            &root,
            "task-1",
            FileChange {
                path: "src/a.ts".into(),
                kind: ChangeKind::Added,
                added: 1,
                removed: 0,
                baseline_content: None,
                pre_existing: false,
            },
        )
        .unwrap();
        mark_reviewed(&root, "task-1", "src/a.ts").unwrap();
        let set = mark_reviewed(&root, "task-1", "src/a.ts").unwrap();
        assert_eq!(set.reviewed_files, vec!["src/a.ts".to_string()]);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn discard_file_restores_one_file_and_drops_its_record() {
        let root = temp_root();
        init_git(&root, &[("src/a.ts", "original")]);
        capture_baseline(&root, "task-1", Vec::new()).unwrap();
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
        init_git(&root, &[("src/seed.ts", "seed\n")]);

        // User's pre-existing dirty edit — must stay protected.
        std::fs::write(root.join("src/seed.ts"), "seed\nuser-edit\n").unwrap();
        capture_baseline(&root, "task-1", vec!["src/seed.ts".to_string()])
            .map_err(|e| {
                eprintln!("baseline error: {e}");
                e
            })
            .unwrap();

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
        // Changes made on top of a dirty file must still be reviewable and
        // rollback restores its exact task-start bytes.
        assert!(
            paths.contains(&"src/seed.ts"),
            "changed dirty file must appear in task changes: {paths:?}"
        );
        assert!(
            set.changes
                .iter()
                .find(|change| change.path == "src/seed.ts")
                .unwrap()
                .pre_existing
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
        assert!(
            !staged_stdout.contains("src/new.ts"),
            "untracked file must not be staged after sync, got:\n{staged_stdout}"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn sync_expands_new_directories_into_reviewable_files() {
        let root = temp_root();
        init_git(&root, &[("README.md", "seed")]);
        capture_baseline(&root, "task-1", Vec::new()).unwrap();
        std::fs::create_dir_all(root.join("new/nested")).unwrap();
        std::fs::write(root.join("new/nested/a.ts"), "one\ntwo\n").unwrap();

        let set = sync_from_git(&root, "task-1").await.unwrap();
        assert_eq!(set.changes.len(), 1);
        assert_eq!(set.changes[0].path, "new/nested/a.ts");
        assert_eq!(set.changes[0].kind, ChangeKind::Added);
        assert!(set.rollback_unsafe_files.is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn line_totals_are_relative_to_the_exact_task_baseline() {
        let root = temp_root();
        init_git(&root, &[("src/a.ts", "one\ntwo\nthree\n")]);
        capture_baseline(&root, "task-1", Vec::new()).unwrap();
        std::fs::write(root.join("src/a.ts"), "one\nTWO\nthree\nfour\n").unwrap();

        let set = sync_from_git(&root, "task-1").await.unwrap();
        assert_eq!(set.changes.len(), 1);
        assert_eq!(set.changes[0].added, 2);
        assert_eq!(set.changes[0].removed, 1);
        std::fs::remove_dir_all(&root).ok();
    }
}
