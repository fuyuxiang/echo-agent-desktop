//! Coding task lifecycle. A workspace can hold several concurrent tasks; each
//! owns its requirement, acceptance criteria, plan and phase, and survives a
//! restart so an interrupted run can be resumed.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::coding::store;
use crate::shell_fs::FilesystemAccess;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum TaskPhase {
    Idle,
    Planning,
    Implementing,
    Verifying,
    Diagnosing,
    Repairing,
    Gating,
    Delivered,
    Blocked,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum TaskNodeStatus {
    Pending,
    Running,
    Success,
    Failed,
    Blocked,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AcceptanceCriterion {
    pub id: String,
    pub content: String,
    /// Only set by the delivery layer from real evidence, never self-reported.
    pub satisfied: bool,
    pub evidence: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TaskNode {
    pub id: String,
    pub content: String,
    pub dependencies: Vec<String>,
    pub related_files: Vec<String>,
    pub status: TaskNodeStatus,
    pub priority: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CodingTask {
    pub id: String,
    pub name: String,
    pub requirement: String,
    pub phase: TaskPhase,
    pub acceptance_criteria: Vec<AcceptanceCriterion>,
    pub task_nodes: Vec<TaskNode>,
    pub plan_required: bool,
    pub model_id: Option<String>,
    pub session_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummary {
    pub id: String,
    pub name: String,
    pub phase: TaskPhase,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Default)]
struct TaskIndex {
    tasks: Vec<TaskSummary>,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn task_path(root: &Path, task_id: &str) -> std::path::PathBuf {
    store::task_dir(root, task_id).join("task.json")
}

pub fn list_tasks(root: &Path) -> Vec<TaskSummary> {
    store::read_json::<TaskIndex>(&store::tasks_index_path(root))
        .unwrap_or_default()
        .tasks
}

fn write_index(root: &Path, tasks: Vec<TaskSummary>) -> Result<(), String> {
    store::write_json(&store::tasks_index_path(root), &TaskIndex { tasks })
}

/// Refresh this task's row in the index, keeping insertion order stable so the
/// task switcher does not reshuffle while a run is in progress.
fn upsert_index(root: &Path, task: &CodingTask) -> Result<(), String> {
    let mut tasks = list_tasks(root);
    let summary = TaskSummary {
        id: task.id.clone(),
        name: task.name.clone(),
        phase: task.phase,
        updated_at: task.updated_at.clone(),
    };
    match tasks.iter_mut().find(|entry| entry.id == task.id) {
        Some(entry) => *entry = summary,
        None => tasks.push(summary),
    }
    write_index(root, tasks)
}

pub fn load(root: &Path, task_id: &str) -> Option<CodingTask> {
    store::read_json(&task_path(root, task_id))
}

pub fn save(root: &Path, task: &CodingTask) -> Result<(), String> {
    let mut stored = task.clone();
    stored.updated_at = now();
    store::write_json(&task_path(root, &stored.id), &stored)?;
    upsert_index(root, &stored)
}

pub fn create_task(root: &Path, name: &str, requirement: &str) -> Result<CodingTask, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("任务名称不能为空".into());
    }
    let timestamp = now();
    let task = CodingTask {
        id: uuid::Uuid::now_v7().to_string(),
        name: trimmed.to_string(),
        requirement: requirement.trim().to_string(),
        phase: TaskPhase::Idle,
        acceptance_criteria: Vec::new(),
        task_nodes: Vec::new(),
        plan_required: false,
        model_id: None,
        session_id: None,
        created_at: timestamp.clone(),
        updated_at: timestamp,
    };
    save(root, &task)?;
    Ok(task)
}

pub fn delete_task(root: &Path, task_id: &str) -> Result<(), String> {
    let dir = store::task_dir(root, task_id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|error| format!("删除任务目录失败：{error}"))?;
    }
    let remaining = list_tasks(root)
        .into_iter()
        .filter(|entry| entry.id != task_id)
        .collect();
    write_index(root, remaining)
}

pub fn rename_task(root: &Path, task_id: &str, name: &str) -> Result<CodingTask, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("任务名称不能为空".into());
    }
    let mut task = load(root, task_id).ok_or_else(|| "任务不存在".to_string())?;
    task.name = trimmed.to_string();
    save(root, &task)?;
    Ok(task)
}

#[tauri::command]
pub async fn coding_task_list(
    access: State<'_, FilesystemAccess>,
    root: String,
) -> Result<Vec<TaskSummary>, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || list_tasks(&root))
        .await
        .map_err(|error| format!("读取任务列表失败：{error}"))
}

#[tauri::command]
pub async fn coding_task_create(
    access: State<'_, FilesystemAccess>,
    root: String,
    name: String,
    requirement: String,
) -> Result<CodingTask, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || create_task(&root, &name, &requirement))
        .await
        .map_err(|error| format!("创建任务失败：{error}"))?
}

#[tauri::command]
pub async fn coding_task_get(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
) -> Result<Option<CodingTask>, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || load(&root, &task_id))
        .await
        .map_err(|error| format!("读取任务失败：{error}"))
}

#[tauri::command]
pub async fn coding_task_delete(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
) -> Result<(), String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || delete_task(&root, &task_id))
        .await
        .map_err(|error| format!("删除任务失败：{error}"))?
}

#[tauri::command]
pub async fn coding_task_rename(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
    name: String,
) -> Result<CodingTask, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || rename_task(&root, &task_id, &name))
        .await
        .map_err(|error| format!("重命名任务失败：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("coding-task-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn creates_multiple_tasks_per_workspace() {
        let root = temp_root();
        let first = create_task(&root, "重构登录", "把登录改成 OIDC").unwrap();
        let second = create_task(&root, "修复导出", "导出乱码").unwrap();
        assert_ne!(first.id, second.id);
        let list = list_tasks(&root);
        assert_eq!(list.len(), 2);
        assert!(list.iter().any(|task| task.name == "重构登录"));
        assert!(list.iter().any(|task| task.name == "修复导出"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn task_survives_reload_with_phase_and_criteria() {
        let root = temp_root();
        let mut task = create_task(&root, "重构登录", "把登录改成 OIDC").unwrap();
        task.phase = TaskPhase::Verifying;
        task.acceptance_criteria = vec![AcceptanceCriterion {
            id: "ac1".into(),
            content: "登录流程可用".into(),
            satisfied: false,
            evidence: Vec::new(),
        }];
        save(&root, &task).unwrap();
        let reloaded = load(&root, &task.id).unwrap();
        assert_eq!(reloaded.phase, TaskPhase::Verifying);
        assert_eq!(reloaded.acceptance_criteria.len(), 1);
        assert_eq!(reloaded.acceptance_criteria[0].content, "登录流程可用");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn delete_removes_task_from_index_and_disk() {
        let root = temp_root();
        let task = create_task(&root, "重构登录", "需求").unwrap();
        let dir = crate::coding::store::task_dir(&root, &task.id);
        assert!(dir.exists());
        delete_task(&root, &task.id).unwrap();
        assert!(list_tasks(&root).is_empty());
        assert!(!dir.exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rename_keeps_id_and_updates_index() {
        let root = temp_root();
        let task = create_task(&root, "旧名", "需求").unwrap();
        rename_task(&root, &task.id, "新名").unwrap();
        let list = list_tasks(&root);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, task.id);
        assert_eq!(list[0].name, "新名");
        std::fs::remove_dir_all(&root).ok();
    }
}
