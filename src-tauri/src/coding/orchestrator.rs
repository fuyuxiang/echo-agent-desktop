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
use crate::coding::task::{self, CodingTask, TaskPhase};
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
        reason: "全部验证通过且存在代码变更".into(),
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
    /// The Agent finished writing code for this round.
    ImplementationFinished,
    /// A verification batch finished; recompute from records on disk.
    VerificationFinished,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PhaseChangedPayload {
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
    let changed_file_count = changeset::load(root, task_id)
        .changes
        .iter()
        .filter(|change| !change.pre_existing)
        .count();

    let decision = match event {
        OrchestratorEvent::RequirementSubmitted { plan_required } => {
            task.plan_required = plan_required;
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
        OrchestratorEvent::PlanApproved => PhaseDecision {
            next_phase: TaskPhase::Implementing,
            reason: "计划已批准".into(),
            blocker: None,
        },
        OrchestratorEvent::ImplementationFinished => {
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
                PhaseDecision {
                    next_phase: TaskPhase::Verifying,
                    reason: format!("已产生 {changed_file_count} 个文件变更，开始验证"),
                    blocker: None,
                }
            }
        }
        OrchestratorEvent::VerificationFinished => {
            let records = verification::list_records(root, task_id);
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
            changed_file_count: changeset::load(&root, &task_id)
                .changes
                .iter()
                .filter(|change| !change.pre_existing)
                .count(),
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
}
