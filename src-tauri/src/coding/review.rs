//! Revision-bound, explicit read-only delivery reviews.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::coding::task::TaskPhase;
use crate::coding::{changeset, store, task};
use crate::shell_fs::FilesystemAccess;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewKind {
    Requirements,
    CodeQuality,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRecord {
    pub kind: ReviewKind,
    pub content_revision: String,
    pub confirmed_at: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct Reviews {
    records: Vec<ReviewRecord>,
}

fn path(root: &Path, task_id: &str) -> std::path::PathBuf {
    store::task_dir(root, task_id).join("reviews.json")
}

pub fn list(root: &Path, task_id: &str) -> Vec<ReviewRecord> {
    store::read_json::<Reviews>(&path(root, task_id))
        .unwrap_or_default()
        .records
}

pub fn confirm(root: &Path, task_id: &str, kind: ReviewKind) -> Result<ReviewRecord, String> {
    let task = task::load(root, task_id).ok_or_else(|| "任务不存在".to_string())?;
    if task.phase != TaskPhase::Delivered {
        return Err("任务尚未完成验证，不能确认交付审查".into());
    }
    let set = changeset::load(root, task_id);
    changeset::ensure_changes_current(root, &set)?;
    if set.changes.is_empty() {
        return Err("只读任务没有文件差异，无需确认代码审查".into());
    }
    let revision = set.content_revision();
    if set.verified_revision.as_deref() != Some(revision.as_str()) {
        return Err("代码已在验证后变化，请重新验证".into());
    }
    if set
        .changes
        .iter()
        .any(|change| set.reviewed_hashes.get(&change.path) != set.change_hashes.get(&change.path))
    {
        return Err("请先打开并审阅每个任务差异文件".into());
    }
    if kind == ReviewKind::Requirements
        && task
            .acceptance_criteria
            .iter()
            .any(|criterion| !criterion.satisfied)
    {
        return Err("请先完成所有验收标准".into());
    }
    if kind == ReviewKind::CodeQuality
        && !list(root, task_id).iter().any(|entry| {
            entry.kind == ReviewKind::Requirements && entry.content_revision == revision
        })
    {
        return Err("请先完成当前代码版本的需求符合性审查".into());
    }
    let record = ReviewRecord {
        kind,
        content_revision: revision,
        confirmed_at: chrono::Utc::now().to_rfc3339(),
    };
    store::update_json(&path(root, task_id), |reviews: &mut Reviews| {
        reviews.records.retain(|entry| entry.kind != kind);
        reviews.records.push(record.clone());
        Ok(())
    })?;
    Ok(record)
}

#[tauri::command]
pub async fn coding_review_confirm(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
    kind: ReviewKind,
) -> Result<ReviewRecord, String> {
    let root = access.require_workspace(&root)?;
    changeset::sync_changes(&root, &task_id).await?;
    tokio::task::spawn_blocking(move || confirm(&root, &task_id, kind))
        .await
        .map_err(|error| format!("记录交付审查失败：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_read_only_task_reports_no_review_is_needed() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let mut coding_task = task::create_task(root, "Explain", "Read the project").unwrap();
        coding_task.phase = TaskPhase::Delivered;
        task::save(root, &coding_task).unwrap();

        assert_eq!(
            confirm(root, &coding_task.id, ReviewKind::Requirements).unwrap_err(),
            "只读任务没有文件差异，无需确认代码审查"
        );
    }

    #[tokio::test]
    async fn two_reviews_are_ordered_and_bound_to_current_content() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let mut coding_task = task::create_task(root, "Review", "Change file").unwrap();
        changeset::capture_filesystem_baseline(root, &coding_task.id).unwrap();
        std::fs::write(root.join("source.txt"), "first\n").unwrap();
        changeset::sync_changes(root, &coding_task.id)
            .await
            .unwrap();
        changeset::mark_reviewed(root, &coding_task.id, "source.txt").unwrap();
        changeset::mark_verification_started(root, &coding_task.id).unwrap();
        changeset::mark_verified_revision(root, &coding_task.id).unwrap();
        coding_task.phase = TaskPhase::Delivered;
        coding_task.acceptance_criteria[0].satisfied = true;
        task::save(root, &coding_task).unwrap();

        assert!(confirm(root, &coding_task.id, ReviewKind::CodeQuality).is_err());
        confirm(root, &coding_task.id, ReviewKind::Requirements).unwrap();
        confirm(root, &coding_task.id, ReviewKind::CodeQuality).unwrap();
        assert_eq!(list(root, &coding_task.id).len(), 2);

        std::fs::write(root.join("source.txt"), "second\n").unwrap();
        changeset::sync_changes(root, &coding_task.id)
            .await
            .unwrap();
        assert!(confirm(root, &coding_task.id, ReviewKind::CodeQuality).is_err());
        let set = changeset::load(root, &coding_task.id);
        assert!(list(root, &coding_task.id)
            .iter()
            .all(|review| review.content_revision != set.content_revision()));
    }
}
