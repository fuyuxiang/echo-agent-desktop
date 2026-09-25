//! Test-first evidence is based on an actual failed native test run, not an
//! Agent assertion. The red checkpoint is captured while only test files have
//! changed, then compared with the later verified implementation revision.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::coding::changeset::{self, ChangeSet};
use crate::coding::store;
use crate::coding::task::{self, CodingTask, TaskPhase};
use crate::coding::verification::{self, VerificationKind, VerificationRecord, VerificationStatus};
use crate::shell_fs::FilesystemAccess;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TddEvidence {
    pub red_command: Option<String>,
    pub red_record_id: Option<String>,
    pub red_revision: Option<String>,
    pub red_at: Option<String>,
    pub waiver_reason: Option<String>,
}

fn path(root: &Path, task_id: &str) -> std::path::PathBuf {
    store::task_dir(root, task_id).join("tdd.json")
}

pub fn load(root: &Path, task_id: &str) -> TddEvidence {
    store::read_json(&path(root, task_id)).unwrap_or_default()
}

pub fn clear(root: &Path, task_id: &str) -> Result<(), String> {
    store::write_json(&path(root, task_id), &TddEvidence::default())
}

pub fn is_test_path(path: &str) -> bool {
    let path = path.replace('\\', "/").to_lowercase();
    let name = path.rsplit('/').next().unwrap_or(&path);
    path.contains("/__tests__/")
        || path.starts_with("tests/")
        || path.contains("/tests/")
        || name.starts_with("test_")
        || name.ends_with("_test.rs")
        || name.ends_with("_test.go")
        || name.contains(".test.")
        || name.contains(".spec.")
        || name.ends_with("test.java")
        || name.ends_with("tests.java")
}

pub fn test_commands(root: &Path, task: &CodingTask) -> Vec<String> {
    let mut commands = verification::detect_commands(root)
        .into_iter()
        .filter(|command| command.kind == VerificationKind::Test)
        .map(|command| command.command)
        .collect::<Vec<_>>();
    for command in task
        .task_nodes
        .iter()
        .flat_map(|node| node.verification_commands.iter())
    {
        let lower = command.to_lowercase();
        if ["test", "pytest", "vitest", "jest", "spec"]
            .iter()
            .any(|word| lower.contains(word))
            && !commands.contains(command)
        {
            commands.push(command.clone());
        }
    }
    commands
}

pub fn only_test_changes(set: &ChangeSet) -> bool {
    !set.changes.is_empty() && set.changes.iter().all(|change| is_test_path(&change.path))
}

pub fn needs_test_first(root: &Path, task: &CodingTask, set: &ChangeSet) -> bool {
    !crate::coding::documentation::is_read_only_task(task)
        && !test_commands(root, task).is_empty()
        && set.changes.iter().any(|change| !is_test_path(&change.path))
}

pub fn should_pause_for_red(root: &Path, task: &CodingTask, set: &ChangeSet) -> bool {
    let evidence = load(root, &task.id);
    evidence.red_record_id.is_none()
        && evidence.waiver_reason.is_none()
        && !test_commands(root, task).is_empty()
        && only_test_changes(set)
}

pub fn can_resume(root: &Path, task: &CodingTask) -> bool {
    if task.phase_reason.as_deref() != Some("等待红灯测试验证") {
        return true;
    }
    let evidence = load(root, &task.id);
    evidence.red_record_id.is_some() || evidence.waiver_reason.is_some()
}

pub fn record_red(root: &Path, task_id: &str, record_id: &str) -> Result<TddEvidence, String> {
    let task = task::load(root, task_id).ok_or_else(|| "任务不存在".to_string())?;
    if task.phase != TaskPhase::Paused || task.phase_reason.as_deref() != Some("等待红灯测试验证")
    {
        return Err("任务未停在测试先行检查点".into());
    }
    let set = changeset::load(root, task_id);
    changeset::ensure_changes_current(root, &set)?;
    if !only_test_changes(&set) {
        return Err("红灯运行前只允许测试文件发生变化".into());
    }
    let record = verification::list_records(root, task_id)
        .into_iter()
        .find(|record| record.id == record_id)
        .ok_or_else(|| "未找到该次验证的原生执行记录".to_string())?;
    if record.kind != VerificationKind::Test
        || record.status != VerificationStatus::Failed
        || !test_commands(root, &task).contains(&record.command)
        || record.content_revision.as_deref() != Some(set.content_revision().as_str())
        || record.started_at.as_str() < task.updated_at.as_str()
    {
        return Err("只有检查点之后执行的计划内测试真实失败结果可作为 RED 证据".into());
    }
    let evidence = TddEvidence {
        red_command: Some(record.command),
        red_record_id: Some(record.id),
        red_revision: Some(set.content_revision()),
        red_at: Some(record.finished_at),
        waiver_reason: None,
    };
    store::write_json(&path(root, task_id), &evidence)?;
    Ok(evidence)
}

pub fn waive(root: &Path, task_id: &str, reason: &str) -> Result<TddEvidence, String> {
    let task = task::load(root, task_id).ok_or_else(|| "任务不存在".to_string())?;
    if !matches!(
        task.phase,
        TaskPhase::Paused | TaskPhase::Delivered | TaskPhase::Blocked
    ) {
        return Err("请在任务暂停或完成后说明测试先行豁免原因".into());
    }
    let reason = reason.trim();
    if reason.chars().count() < 8 || reason.chars().count() > 500 {
        return Err("请填写 8 到 500 字的具体豁免原因".into());
    }
    let evidence = TddEvidence {
        waiver_reason: Some(reason.into()),
        ..TddEvidence::default()
    };
    store::write_json(&path(root, task_id), &evidence)?;
    Ok(evidence)
}

pub fn green_record<'a>(
    evidence: &TddEvidence,
    records: &'a [VerificationRecord],
    set: &ChangeSet,
) -> Option<&'a VerificationRecord> {
    if evidence.red_revision.as_deref() == Some(set.content_revision().as_str()) {
        return None;
    }
    let command = evidence.red_command.as_deref()?;
    let red_at = evidence.red_at.as_deref()?;
    let revision = set.content_revision();
    records.iter().rev().find(|record| {
        record.kind == VerificationKind::Test
            && record.command == command
            && record.status == VerificationStatus::Passed
            && record.content_revision.as_deref() == Some(revision.as_str())
            && record.started_at.as_str() >= red_at
    })
}

#[tauri::command]
pub async fn coding_tdd_status(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
) -> Result<TddEvidence, String> {
    let root = access.require_workspace(&root)?;
    store::validate_task_id(&task_id)?;
    Ok(load(&root, &task_id))
}

#[tauri::command]
pub async fn coding_tdd_record_red(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
    record_id: String,
) -> Result<TddEvidence, String> {
    let root = access.require_workspace(&root)?;
    changeset::sync_changes(&root, &task_id).await?;
    tokio::task::spawn_blocking(move || record_red(&root, &task_id, &record_id))
        .await
        .map_err(|error| format!("记录红灯测试失败：{error}"))?
}

#[tauri::command]
pub async fn coding_tdd_waive(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
    reason: String,
) -> Result<TddEvidence, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || waive(&root, &task_id, &reason))
        .await
        .map_err(|error| format!("记录测试先行豁免失败：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifies_common_test_files_without_classifying_source_files() {
        for path in [
            "src/user.test.ts",
            "src/__tests__/user.ts",
            "tests/api.py",
            "src/user_test.rs",
            "src/UserTest.java",
        ] {
            assert!(is_test_path(path), "{path}");
        }
        assert!(!is_test_path("src/user.ts"));
    }

    #[tokio::test]
    async fn red_failure_then_green_pass_is_revision_bound() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let mut coding_task = task::create_task(root, "TDD", "Fix behavior").unwrap();
        coding_task.task_nodes[0].verification_commands = vec!["pnpm test".into()];
        coding_task.phase = TaskPhase::Paused;
        coding_task.phase_reason = Some("等待红灯测试验证".into());
        task::save(root, &coding_task).unwrap();
        changeset::capture_filesystem_baseline(root, &coding_task.id).unwrap();
        std::fs::create_dir_all(root.join("tests")).unwrap();
        std::fs::write(
            root.join("tests/user.test.ts"),
            "expect(false).toBe(true)\n",
        )
        .unwrap();
        let red_set = changeset::sync_changes(root, &coding_task.id)
            .await
            .unwrap();
        assert!(only_test_changes(&red_set));
        assert!(should_pause_for_red(root, &coding_task, &red_set));
        let mut red = verification::record_from_parts(
            &coding_task.id,
            VerificationKind::Test,
            "pnpm test",
            Some(1),
            String::new(),
            "failed".into(),
            1,
            false,
            false,
        );
        red.content_revision = Some(red_set.content_revision());
        verification::append_record(root, &red).unwrap();
        let evidence = record_red(root, &coding_task.id, &red.id).unwrap();
        assert!(can_resume(root, &coding_task));
        assert!(green_record(&evidence, &[], &red_set).is_none());

        std::fs::write(root.join("src.ts"), "export const fixed = true;\n").unwrap();
        let green_set = changeset::sync_changes(root, &coding_task.id)
            .await
            .unwrap();
        let mut green = verification::record_from_parts(
            &coding_task.id,
            VerificationKind::Test,
            "pnpm test",
            Some(0),
            "passed".into(),
            String::new(),
            1,
            false,
            false,
        );
        assert!(green_record(&evidence, &[green.clone()], &green_set).is_none());
        green.content_revision = Some(green_set.content_revision());
        assert_eq!(
            green_record(&evidence, &[green], &green_set).map(|record| record.status),
            Some(VerificationStatus::Passed)
        );
    }
}
