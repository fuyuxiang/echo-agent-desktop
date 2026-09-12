//! Phase orchestration for a coding task.
//!
//! The workbench — not the model — decides when a task moves forward. A phase
//! transition is derived from real evidence: process exit codes, the change set
//! on disk and diagnostic fingerprints. This is what stops a model that claims
//! "all tests pass" from marking work complete, and what stops a repair loop
//! from burning tokens on the same failure forever.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::coding::changeset;
use crate::coding::diagnostics::{self, Problem};
use crate::coding::store;
use crate::coding::task::{self, CodingTask, TaskNodeStatus, TaskPhase};
use crate::coding::verification::{self, VerificationRecord, VerificationStatus};
use crate::shell_fs::FilesystemAccess;

pub const DEFAULT_MAX_REPAIR_ROUNDS: u32 = 3;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum RepairOutcome {
    Fixed,
    SameErrors,
    NewErrors,
    RoundsExhausted,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RepairRound {
    pub round: u32,
    pub problem_fingerprints: Vec<String>,
    pub started_at: String,
    pub outcome: Option<RepairOutcome>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PhaseDecision {
    pub next_phase: TaskPhase,
    pub reason: String,
    /// Human-readable blocker, set only when `next_phase` is `Blocked`.
    pub blocker: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorState {
    pub task: CodingTask,
    pub problems: Vec<Problem>,
    pub repair_rounds: Vec<RepairRound>,
    pub changed_file_count: usize,
    pub max_repair_rounds: u32,
}

fn repairs_path(root: &Path, task_id: &str) -> PathBuf {
    store::task_dir(root, task_id).join("repairs.jsonl")
}

pub fn repair_rounds(root: &Path, task_id: &str) -> Vec<RepairRound> {
    store::read_jsonl(&repairs_path(root, task_id))
}

fn append_round(root: &Path, task_id: &str, round: &RepairRound) -> Result<(), String> {
    store::append_jsonl(&repairs_path(root, task_id), round)
}

/// A simple task skips planning; only work the user marked as plan-first stops
/// for approval.
pub fn phase_after_requirement(plan_required: bool) -> TaskPhase {
    if plan_required {
        TaskPhase::Planning
    } else {
        TaskPhase::Implementing
    }
}

/// Keep only the most recent run of each command, so a failure that a later run
/// fixed does not hold the task in a red state.
fn latest_per_command(records: &[VerificationRecord]) -> Vec<&VerificationRecord> {
    let mut latest: Vec<&VerificationRecord> = Vec::new();
    for record in records {
        match latest
            .iter_mut()
            .find(|existing| existing.command == record.command)
        {
            Some(existing) => *existing = record,
            None => latest.push(record),
        }
    }
    latest
}

fn missing_detected_commands(root: &Path, records: &[VerificationRecord]) -> Vec<String> {
    let completed: HashSet<&str> = records
        .iter()
        .map(|record| record.command.as_str())
        .collect();
    verification::detect_commands(root)
        .into_iter()
        .filter(|expected| !completed.contains(expected.command.as_str()))
        .map(|expected| expected.command)
        .collect()
}

/// Decide where a task goes once verification finished.
pub fn decide_after_verification(
    records: &[VerificationRecord],
    changed_file_count: usize,
) -> PhaseDecision {
    let effective = latest_per_command(records);
    let failing: Vec<&&VerificationRecord> = effective
        .iter()
        .filter(|record| record.status != VerificationStatus::Passed)
        .collect();

    if !failing.is_empty() {
        let commands = failing
            .iter()
            .map(|record| record.command.as_str())
            .collect::<Vec<_>>()
            .join("、");
        return PhaseDecision {
            next_phase: TaskPhase::Diagnosing,
            reason: format!("以下验证未通过：{commands}"),
            blocker: None,
        };
    }

    if changed_file_count == 0 {
        return PhaseDecision {
            next_phase: TaskPhase::Blocked,
            reason: "验证通过但没有代码变更".into(),
            blocker: Some(
                "本轮没有产生任何代码变更，无法作为已完成的开发任务交付。请确认需求是否已被实现。"
                    .into(),
            ),
        };
    }

    PhaseDecision {
        next_phase: TaskPhase::Gating,
        reason: if effective.is_empty() {
            "工程未配置可识别的自动验证，已进入人工差异审阅".into()
        } else {
            "全部验证通过且存在代码变更".into()
        },
        blocker: None,
    }
}

/// Decide whether another repair round is worth attempting.
pub fn next_after_repair(
    problems: &[Problem],
    previous_fingerprints: &[String],
    completed_rounds: u32,
    max_rounds: u32,
) -> PhaseDecision {
    if problems.is_empty() {
        return PhaseDecision {
            next_phase: TaskPhase::Verifying,
            reason: "修复后没有残留问题，重新执行验证".into(),
            blocker: None,
        };
    }

    let current: HashSet<&str> = problems
        .iter()
        .map(|problem| problem.fingerprint.as_str())
        .collect();
    let previous: HashSet<&str> = previous_fingerprints
        .iter()
        .map(|value| value.as_str())
        .collect();

    if !previous.is_empty() {
        let introduced: Vec<&&str> = current.difference(&previous).collect();
        if !introduced.is_empty() {
            return PhaseDecision {
                next_phase: TaskPhase::Blocked,
                reason: "修复引入了新的错误".into(),
                blocker: Some(format!(
                    "上一轮修复引入了 {} 个新的错误，已停止自动修复以避免问题扩散。请人工确认修改方向。",
                    introduced.len()
                )),
            };
        }
        if current == previous {
            return PhaseDecision {
                next_phase: TaskPhase::Blocked,
                reason: "修复后仍是相同错误".into(),
                blocker: Some(
                    "修复后出现完全相同错误，说明当前思路无效，已停止自动修复以避免空转。请人工介入。"
                        .into(),
                ),
            };
        }
    }

    if completed_rounds >= max_rounds {
        return PhaseDecision {
            next_phase: TaskPhase::Blocked,
            reason: "修复轮次已用尽".into(),
            blocker: Some(format!(
                "已执行 {completed_rounds} 轮自动修复仍有 {} 个问题未解决，修复轮次上限为 {max_rounds}。请人工介入。",
                problems.len()
            )),
        };
    }

    PhaseDecision {
        next_phase: TaskPhase::Repairing,
        reason: format!("问题数量下降到 {}，继续自动修复", problems.len()),
        blocker: None,
    }
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum OrchestratorEvent {
    /// The user submitted a requirement; the task leaves Idle.
    RequirementSubmitted { plan_required: bool },
    /// The user approved the plan the Agent produced.
    PlanApproved,
    /// The user abandoned the pending plan.
    PlanAbandoned,
    /// Creating or starting the bound Agent session failed.
    StartFailed { reason: String },
    /// The user asked the bound Agent to make another change after a terminal
    /// or review phase. Re-open the same task before any file can be written.
    FollowupStarted,
    /// The Agent finished writing code for this round.
    ImplementationFinished,
    /// The user explicitly re-runs checks from a settled phase.
    VerificationStarted,
    /// A verification batch finished; recompute from records on disk.
    VerificationFinished,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PhaseChangedPayload {
    root: String,
    task_id: String,
    phase: TaskPhase,
    reason: String,
    blocker: Option<String>,
}

/// Apply one event and persist the resulting phase.
pub fn apply(
    root: &Path,
    task_id: &str,
    event: OrchestratorEvent,
) -> Result<(CodingTask, PhaseDecision), String> {
    let mut task = task::load(root, task_id).ok_or_else(|| "任务不存在".to_string())?;
    let changed_file_count = changeset::load(root, task_id).changes.len();

    let decision = match event {
        OrchestratorEvent::RequirementSubmitted { plan_required } => {
            if task.phase != TaskPhase::Idle {
                return Err("只有未开始任务可以提交需求".into());
            }
            task.plan_required = plan_required;
            if !plan_required {
                if let Some(node) = task.task_nodes.first_mut() {
                    node.status = TaskNodeStatus::Running;
                }
            }
            let next = phase_after_requirement(plan_required);
            PhaseDecision {
                next_phase: next,
                reason: if plan_required {
                    "需求已提交，等待 Agent 给出计划".into()
                } else {
                    "需求已提交，直接开始实现".into()
                },
                blocker: None,
            }
        }
        OrchestratorEvent::PlanApproved => {
            if task.phase != TaskPhase::Planning {
                return Err("当前任务不在等待计划审批状态".into());
            }
            if let Some(node) = task.task_nodes.first_mut() {
                node.status = TaskNodeStatus::Running;
            }
            PhaseDecision {
                next_phase: TaskPhase::Implementing,
                reason: "计划已批准，Agent 开始执行".into(),
                blocker: None,
            }
        }
        OrchestratorEvent::PlanAbandoned => {
            if task.phase != TaskPhase::Planning {
                return Err("当前任务不在等待计划审批状态".into());
            }
            for node in &mut task.task_nodes {
                node.status = TaskNodeStatus::Blocked;
            }
            PhaseDecision {
                next_phase: TaskPhase::Blocked,
                reason: "用户已放弃执行计划".into(),
                blocker: Some("计划已放弃，可以新建任务重新规划。".into()),
            }
        }
        OrchestratorEvent::StartFailed { reason } => {
            if !matches!(
                task.phase,
                TaskPhase::Idle
                    | TaskPhase::Planning
                    | TaskPhase::Implementing
                    | TaskPhase::Repairing
            ) {
                return Err("当前任务已离开 Agent 执行阶段，已忽略过期的失败事件".into());
            }
            PhaseDecision {
                next_phase: TaskPhase::Blocked,
                reason: "Agent 会话执行失败".into(),
                blocker: Some(reason),
            }
        }
        OrchestratorEvent::FollowupStarted => {
            if !matches!(
                task.phase,
                TaskPhase::Gating | TaskPhase::Delivered | TaskPhase::Blocked
            ) {
                return Err("只有待验收、已交付或已阻塞的任务可以继续开发".into());
            }
            if changeset::load(root, task_id).committed_hash.is_some() {
                return Err("该任务已提交到 Git；请新建任务继续开发，避免交付记录失真".into());
            }
            for criterion in &mut task.acceptance_criteria {
                criterion.satisfied = false;
                criterion.evidence.clear();
            }
            for node in &mut task.task_nodes {
                node.status = TaskNodeStatus::Running;
            }
            PhaseDecision {
                next_phase: TaskPhase::Implementing,
                reason: "已接收补充要求，重新进入实现与验证流程".into(),
                blocker: None,
            }
        }
        OrchestratorEvent::ImplementationFinished => {
            if !matches!(task.phase, TaskPhase::Implementing | TaskPhase::Repairing) {
                return Err("只有实现或修复阶段可以报告代码写入完成".into());
            }
            if changed_file_count == 0 {
                PhaseDecision {
                    next_phase: TaskPhase::Blocked,
                    reason: "实现阶段结束但没有代码变更".into(),
                    blocker: Some(
                        "Agent 结束了实现但没有写入任何文件。请检查是否只在会话里返回了示例代码。"
                            .into(),
                    ),
                }
            } else {
                // Test/lint/build passes are content-bound evidence. Never let
                // a new implementation round inherit an earlier green batch.
                verification::clear_records(root, task_id)?;
                diagnostics::save_snapshot(root, task_id, &[])?;
                for node in &mut task.task_nodes {
                    node.status = TaskNodeStatus::Success;
                }
                PhaseDecision {
                    next_phase: TaskPhase::Verifying,
                    reason: format!("已产生 {changed_file_count} 个文件变更，开始验证"),
                    blocker: None,
                }
            }
        }
        OrchestratorEvent::VerificationStarted => {
            if !matches!(
                task.phase,
                TaskPhase::Gating | TaskPhase::Delivered | TaskPhase::Blocked
            ) {
                return Err("只有待验收、已交付或已阻塞的任务可以重新验证".into());
            }
            if changeset::load(root, task_id).committed_hash.is_some() {
                return Err("该任务已提交到 Git，交付证据已封存".into());
            }
            verification::clear_records(root, task_id)?;
            diagnostics::save_snapshot(root, task_id, &[])?;
            for criterion in &mut task.acceptance_criteria {
                criterion.satisfied = false;
                criterion.evidence.clear();
            }
            for node in &mut task.task_nodes {
                node.status = TaskNodeStatus::Running;
            }
            PhaseDecision {
                next_phase: TaskPhase::Verifying,
                reason: "已开始重新验证当前任务内容".into(),
                blocker: None,
            }
        }
        OrchestratorEvent::VerificationFinished => {
            if task.phase != TaskPhase::Verifying {
                return Err("只有验证阶段可以报告验证完成".into());
            }
            let records = verification::list_records(root, task_id);
            let has_current_failure = records
                .iter()
                .any(|record| record.status != VerificationStatus::Passed);
            if !has_current_failure {
                let missing = missing_detected_commands(root, &records);
                if !missing.is_empty() {
                    return Err(format!("尚有验证命令未运行：{}", missing.join("、")));
                }
            }
            let problems: Vec<Problem> = latest_per_command(&records)
                .iter()
                .flat_map(|record| diagnostics::parse_record(record))
                .collect();
            diagnostics::save_snapshot(root, task_id, &problems)?;

            let rounds = repair_rounds(root, task_id);
            let completed = rounds.len() as u32;
            let previous: Vec<String> = rounds
                .last()
                .map(|round| round.problem_fingerprints.clone())
                .unwrap_or_default();

            let verdict = decide_after_verification(&records, changed_file_count);
            if verdict.next_phase != TaskPhase::Diagnosing {
                verdict
            } else {
                // Failing verification: decide whether to repair again, and open
                // a round so the next comparison has a baseline.
                let decision =
                    next_after_repair(&problems, &previous, completed, DEFAULT_MAX_REPAIR_ROUNDS);
                if decision.next_phase == TaskPhase::Repairing {
                    for node in &mut task.task_nodes {
                        node.status = TaskNodeStatus::Failed;
                    }
                    append_round(
                        root,
                        task_id,
                        &RepairRound {
                            round: completed + 1,
                            problem_fingerprints: problems
                                .iter()
                                .map(|problem| problem.fingerprint.clone())
                                .collect(),
                            started_at: chrono::Utc::now().to_rfc3339(),
                            outcome: None,
                        },
                    )?;
                }
                decision
            }
        }
    };

    task.phase = decision.next_phase;
    task.phase_reason = Some(decision.reason.clone());
    task.blocker = decision.blocker.clone();
    task::save(root, &task)?;
    Ok((task, decision))
}

async fn apply_and_emit(
    app: AppHandle,
    root: PathBuf,
    task_id: String,
    event: OrchestratorEvent,
) -> Result<CodingTask, String> {
    let (task, decision) = tokio::task::spawn_blocking({
        let root = root.clone();
        let task_id = task_id.clone();
        move || apply(&root, &task_id, event)
    })
    .await
    .map_err(|error| format!("推进任务阶段失败：{error}"))??;
    let _ = app.emit(
        "coding://task-phase-changed",
        PhaseChangedPayload {
            root: root.to_string_lossy().into_owned(),
            task_id,
            phase: task.phase,
            reason: decision.reason,
            blocker: decision.blocker,
        },
    );
    Ok(task)
}

#[tauri::command]
pub async fn coding_task_submit_requirement(
    app: AppHandle,
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
    plan_required: bool,
) -> Result<CodingTask, String> {
    let root = access.require_workspace(&root)?;
    apply_and_emit(
        app,
        root,
        task_id,
        OrchestratorEvent::RequirementSubmitted { plan_required },
    )
    .await
}

#[tauri::command]
pub async fn coding_task_approve_plan(
    app: AppHandle,
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
) -> Result<CodingTask, String> {
    let root = access.require_workspace(&root)?;
    apply_and_emit(app, root, task_id, OrchestratorEvent::PlanApproved).await
}

#[tauri::command]
pub async fn coding_task_resolve_plan(
    app: AppHandle,
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
    outcome: String,
    plan_entries: Vec<String>,
) -> Result<CodingTask, String> {
    let root = access.require_workspace(&root)?;
    match outcome.as_str() {
        "approved" => {
            let write_root = root.clone();
            let write_task_id = task_id.clone();
            tokio::task::spawn_blocking(move || {
                task::set_plan_steps(&write_root, &write_task_id, plan_entries)
            })
            .await
            .map_err(|error| format!("保存任务计划失败：{error}"))??;
            apply_and_emit(app, root, task_id, OrchestratorEvent::PlanApproved).await
        }
        "abandoned" => apply_and_emit(app, root, task_id, OrchestratorEvent::PlanAbandoned).await,
        "cancelled" => task::load(&root, &task_id).ok_or_else(|| "任务不存在".into()),
        _ => Err("不支持的计划审批结果".into()),
    }
}

#[tauri::command]
pub async fn coding_task_report_start_failed(
    app: AppHandle,
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
    reason: String,
) -> Result<CodingTask, String> {
    let root = access.require_workspace(&root)?;
    apply_and_emit(
        app,
        root,
        task_id,
        OrchestratorEvent::StartFailed { reason },
    )
    .await
}

#[tauri::command]
pub async fn coding_task_begin_followup(
    app: AppHandle,
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
) -> Result<CodingTask, String> {
    let root = access.require_workspace(&root)?;
    apply_and_emit(app, root, task_id, OrchestratorEvent::FollowupStarted).await
}

#[tauri::command]
pub async fn coding_orchestrator_report_implementation(
    app: AppHandle,
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
) -> Result<CodingTask, String> {
    let root = access.require_workspace(&root)?;
    apply_and_emit(
        app,
        root,
        task_id,
        OrchestratorEvent::ImplementationFinished,
    )
    .await
}

#[tauri::command]
pub async fn coding_task_begin_verification(
    app: AppHandle,
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
) -> Result<CodingTask, String> {
    let root = access.require_workspace(&root)?;
    apply_and_emit(app, root, task_id, OrchestratorEvent::VerificationStarted).await
}

#[tauri::command]
pub async fn coding_orchestrator_report_verification(
    app: AppHandle,
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
) -> Result<CodingTask, String> {
    let root = access.require_workspace(&root)?;
    apply_and_emit(app, root, task_id, OrchestratorEvent::VerificationFinished).await
}

#[tauri::command]
pub async fn coding_orchestrator_state(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
) -> Result<OrchestratorState, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || {
        let task = task::load(&root, &task_id).ok_or_else(|| "任务不存在".to_string())?;
        Ok(OrchestratorState {
            problems: diagnostics::load_snapshot(&root, &task_id),
            repair_rounds: repair_rounds(&root, &task_id),
            changed_file_count: changeset::load(&root, &task_id).changes.len(),
            max_repair_rounds: DEFAULT_MAX_REPAIR_ROUNDS,
            task,
        })
    })
    .await
    .map_err(|error| format!("读取编排状态失败：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coding::verification::{record_from_parts, VerificationKind};

    fn passed(command: &str) -> VerificationRecord {
        record_from_parts(
            "task-1",
            VerificationKind::Test,
            command,
            Some(0),
            String::new(),
            String::new(),
            10,
            false,
            false,
        )
    }

    fn failed(command: &str, output: &str) -> VerificationRecord {
        record_from_parts(
            "task-1",
            VerificationKind::Test,
            command,
            Some(1),
            output.to_string(),
            String::new(),
            10,
            false,
            false,
        )
    }

    #[test]
    fn all_green_with_changes_goes_to_gating() {
        let decision = decide_after_verification(&[passed("pnpm build"), passed("pnpm test")], 3);
        assert_eq!(decision.next_phase, TaskPhase::Gating);
        assert!(decision.blocker.is_none());
    }

    #[test]
    fn green_verification_without_any_changes_is_blocked() {
        let decision = decide_after_verification(&[passed("pnpm test")], 0);
        assert_eq!(decision.next_phase, TaskPhase::Blocked);
        assert!(decision
            .blocker
            .as_deref()
            .unwrap()
            .contains("没有产生任何代码变更"));
    }

    #[test]
    fn failure_goes_to_diagnosing() {
        let decision =
            decide_after_verification(&[failed("pnpm test", "src/a.ts(1,1): error TS1: bad")], 2);
        assert_eq!(decision.next_phase, TaskPhase::Diagnosing);
    }

    #[test]
    fn identical_fingerprints_across_rounds_block_instead_of_looping() {
        let record = failed("pnpm test", "src/a.ts(1,1): error TS1: bad");
        let problems = crate::coding::diagnostics::parse_record(&record);
        let previous: Vec<String> = problems
            .iter()
            .map(|problem| problem.fingerprint.clone())
            .collect();
        let decision = next_after_repair(&problems, &previous, 1, 3);
        assert_eq!(decision.next_phase, TaskPhase::Blocked);
        assert!(decision.blocker.as_deref().unwrap().contains("相同错误"));
    }

    #[test]
    fn new_fingerprints_after_repair_block_as_regression() {
        let previous = vec!["aaaaaaaa".to_string()];
        let record = failed("pnpm test", "src/b.ts(9,9): error TS7: different");
        let problems = crate::coding::diagnostics::parse_record(&record);
        let decision = next_after_repair(&problems, &previous, 1, 3);
        assert_eq!(decision.next_phase, TaskPhase::Blocked);
        assert!(decision.blocker.as_deref().unwrap().contains("新的错误"));
    }

    #[test]
    fn shrinking_problem_set_continues_repairing() {
        let previous = vec!["aaaaaaaa".to_string(), "bbbbbbbb".to_string()];
        let record = failed("pnpm test", "src/a.ts(1,1): error TS1: bad");
        let mut problems = crate::coding::diagnostics::parse_record(&record);
        problems[0].fingerprint = "aaaaaaaa".into();
        let decision = next_after_repair(&problems, &previous, 1, 3);
        assert_eq!(decision.next_phase, TaskPhase::Repairing);
    }

    #[test]
    fn exhausted_rounds_block_even_when_progress_is_being_made() {
        let previous = vec!["aaaaaaaa".to_string(), "bbbbbbbb".to_string()];
        let record = failed("pnpm test", "src/a.ts(1,1): error TS1: bad");
        let mut problems = crate::coding::diagnostics::parse_record(&record);
        problems[0].fingerprint = "aaaaaaaa".into();
        let decision = next_after_repair(&problems, &previous, 3, 3);
        assert_eq!(decision.next_phase, TaskPhase::Blocked);
        assert!(decision.blocker.as_deref().unwrap().contains("修复轮次"));
    }

    #[test]
    fn empty_problem_set_after_repair_returns_to_verifying() {
        let decision = next_after_repair(&[], &["aaaaaaaa".to_string()], 1, 3);
        assert_eq!(decision.next_phase, TaskPhase::Verifying);
    }

    #[test]
    fn requirement_submission_respects_plan_flag() {
        assert_eq!(phase_after_requirement(true), TaskPhase::Planning);
        assert_eq!(phase_after_requirement(false), TaskPhase::Implementing);
    }

    #[test]
    fn cancelled_or_timed_out_verification_is_not_a_pass() {
        let cancelled = record_from_parts(
            "task-1",
            VerificationKind::Test,
            "pnpm test",
            None,
            String::new(),
            String::new(),
            10,
            false,
            true,
        );
        let decision = decide_after_verification(&[cancelled], 2);
        assert_eq!(decision.next_phase, TaskPhase::Diagnosing);
    }

    #[test]
    fn only_latest_run_per_command_counts() {
        // An early failure that a later run fixed must not keep the task red.
        let decision = decide_after_verification(
            &[
                failed("pnpm test", "src/a.ts(1,1): error TS1: bad"),
                passed("pnpm test"),
            ],
            2,
        );
        assert_eq!(decision.next_phase, TaskPhase::Gating);
    }

    #[test]
    fn a_partial_green_batch_cannot_skip_other_detected_checks() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("package.json"),
            r#"{"scripts":{"build":"vite build","test":"vitest run"}}"#,
        )
        .unwrap();
        let records = vec![passed("npm run test")];
        assert_eq!(
            missing_detected_commands(dir.path(), &records),
            vec!["npm run build".to_string()]
        );
    }

    #[test]
    fn followup_reopens_task_and_invalidates_delivery_acceptance() {
        let dir = tempfile::tempdir().unwrap();
        let mut task = task::create_task(dir.path(), "task", "implement it").unwrap();
        task.phase = TaskPhase::Delivered;
        task.acceptance_criteria[0].satisfied = true;
        task.acceptance_criteria[0].evidence = vec!["previous delivery".into()];
        task.task_nodes[0].status = TaskNodeStatus::Success;
        task::save(dir.path(), &task).unwrap();

        let (reopened, decision) =
            apply(dir.path(), &task.id, OrchestratorEvent::FollowupStarted).unwrap();

        assert_eq!(decision.next_phase, TaskPhase::Implementing);
        assert!(!reopened.acceptance_criteria[0].satisfied);
        assert!(reopened.acceptance_criteria[0].evidence.is_empty());
        assert_eq!(reopened.task_nodes[0].status, TaskNodeStatus::Running);
    }

    #[test]
    fn committed_task_cannot_be_reopened_as_the_same_delivery() {
        let dir = tempfile::tempdir().unwrap();
        let mut task = task::create_task(dir.path(), "task", "implement it").unwrap();
        task.phase = TaskPhase::Delivered;
        task::save(dir.path(), &task).unwrap();
        changeset::mark_committed(dir.path(), &task.id, "abc123").unwrap();

        let error = apply(dir.path(), &task.id, OrchestratorEvent::FollowupStarted).unwrap_err();
        assert!(error.contains("已提交到 Git"));
    }
}
