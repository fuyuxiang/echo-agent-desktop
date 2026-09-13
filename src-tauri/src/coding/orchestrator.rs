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
use crate::coding::task::{
    self, AcceptanceCriterion, CodingTask, ExecutionLedgerEvent, PlanIssueSeverity,
    RuntimePlanEntry, TaskNextAction, TaskNode, TaskNodeStatus, TaskPhase,
};
use crate::coding::verification::{self, VerificationRecord, VerificationStatus};
use crate::shell_fs::FilesystemAccess;

pub const DEFAULT_MAX_REPAIR_ROUNDS: u32 = 3;
pub const DEFAULT_MAX_NODE_ATTEMPTS: u32 = 3;
pub const DEFAULT_MAX_PLAN_REVISIONS: usize = 3;

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

fn missing_planned_commands(task: &CodingTask, records: &[VerificationRecord]) -> Vec<String> {
    let completed: HashSet<&str> = records
        .iter()
        .map(|record| record.command.as_str())
        .collect();
    let mut missing = Vec::new();
    for command in task
        .task_nodes
        .iter()
        .flat_map(|node| node.verification_commands.iter())
    {
        if !completed.contains(command.as_str()) && !missing.contains(command) {
            missing.push(command.clone());
        }
    }
    missing
}

fn count_ledger_events(root: &Path, task_id: &str, kind: &str) -> usize {
    task::execution_ledger(root, task_id)
        .iter()
        .filter(|event| event.kind == kind)
        .count()
}

/// Select exactly one ready node and persist the retry attempt on the task.
/// The renderer uses `next_action` to start the next managed Agent turn; it
/// never guesses readiness from display state.
fn schedule_next_node(task: &mut CodingTask) -> Result<String, String> {
    let statuses = task
        .task_nodes
        .iter()
        .map(|node| (node.plan_key.clone(), node.status))
        .collect::<std::collections::HashMap<_, _>>();
    let candidate =
        task.task_nodes
            .iter()
            .position(|node| node.status == TaskNodeStatus::Running)
            .or_else(|| {
                task.task_nodes.iter().position(|node| {
                    matches!(
                        node.status,
                        TaskNodeStatus::Pending | TaskNodeStatus::Failed
                    ) && node.dependencies.iter().all(|dependency| {
                        statuses.get(dependency) == Some(&TaskNodeStatus::Success)
                    })
                })
            })
            .ok_or_else(|| "没有依赖已满足的可执行节点".to_string())?;
    let node = &mut task.task_nodes[candidate];
    if node.attempt >= DEFAULT_MAX_NODE_ATTEMPTS {
        return Err(format!(
            "节点“{}”连续执行 {} 次仍未完成",
            node.plan_key, node.attempt
        ));
    }
    node.status = TaskNodeStatus::Running;
    node.attempt = node.attempt.saturating_add(1);
    node.started_at
        .get_or_insert_with(|| chrono::Utc::now().to_rfc3339());
    node.completed_at = None;
    node.failure = None;
    Ok(node.plan_key.clone())
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
        next_phase: TaskPhase::Delivered,
        reason: if effective.is_empty() {
            "任务已完成；当前工程未检测到可运行的自动检查".into()
        } else {
            format!("任务已完成，{} 项自动检查通过", effective.len())
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
    RequirementSubmitted,
    /// A valid structured plan was emitted by the runtime.
    PlanSynchronized,
    /// Creating or starting the bound Agent session failed.
    StartFailed { reason: String },
    /// The user asked the bound Agent to make another change after a terminal
    /// or review phase. Re-open the same task before any file can be written.
    FollowupStarted { requirement: String },
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
    let change_set = changeset::load(root, task_id);
    let changed_file_count = change_set.changes.len();
    task.next_action = None;
    let mut workflow_ledger: Option<(&str, Option<String>, String)> = None;
    let event_kind = match &event {
        OrchestratorEvent::RequirementSubmitted => "requirement_submitted",
        OrchestratorEvent::PlanSynchronized => "plan_progress",
        OrchestratorEvent::StartFailed { .. } => "agent_start_failed",
        OrchestratorEvent::FollowupStarted { .. } => "followup_started",
        OrchestratorEvent::ImplementationFinished => "implementation_finished",
        OrchestratorEvent::VerificationStarted => "verification_started",
        OrchestratorEvent::VerificationFinished => "verification_finished",
    };

    let decision = match event {
        OrchestratorEvent::RequirementSubmitted => {
            if task.phase != TaskPhase::Idle {
                return Err("只有未开始任务可以提交需求".into());
            }
            if let Some(node) = task.task_nodes.first_mut() {
                node.status = TaskNodeStatus::Running;
                node.attempt = 1;
                node.started_at = Some(chrono::Utc::now().to_rfc3339());
            }
            PhaseDecision {
                next_phase: TaskPhase::Discovering,
                reason: "Agent 正在理解需求、分析工程并准备执行计划".into(),
                blocker: None,
            }
        }
        OrchestratorEvent::PlanSynchronized => {
            if !matches!(
                task.phase,
                TaskPhase::Discovering | TaskPhase::Implementing | TaskPhase::Repairing
            ) {
                return Err("当前任务阶段不能同步执行计划".into());
            }
            PhaseDecision {
                next_phase: TaskPhase::Implementing,
                reason: format!(
                    "已拆解 {} 个执行节点，Agent 正按依赖顺序实施",
                    task.task_nodes.len()
                ),
                blocker: None,
            }
        }
        OrchestratorEvent::StartFailed { reason } => {
            let was_verifying = task.phase == TaskPhase::Verifying;
            if !matches!(
                task.phase,
                TaskPhase::Idle
                    | TaskPhase::Discovering
                    | TaskPhase::Implementing
                    | TaskPhase::Repairing
                    | TaskPhase::Verifying
            ) {
                return Err("当前任务已离开执行阶段，已忽略过期的失败事件".into());
            }
            PhaseDecision {
                next_phase: TaskPhase::Blocked,
                reason: if was_verifying {
                    "验证执行中断".into()
                } else {
                    "Agent 会话执行失败".into()
                },
                blocker: Some(reason),
            }
        }
        OrchestratorEvent::FollowupStarted { requirement } => {
            if !matches!(task.phase, TaskPhase::Delivered | TaskPhase::Blocked) {
                return Err("只有已完成或已阻塞的任务可以继续开发".into());
            }
            if changeset::load(root, task_id).committed_hash.is_some() {
                return Err("该任务已提交到 Git；请新建任务继续开发，避免交付记录失真".into());
            }
            let requirement = requirement.trim();
            if requirement.is_empty() {
                return Err("补充要求不能为空".into());
            }
            for criterion in &mut task.acceptance_criteria {
                criterion.satisfied = false;
                criterion.evidence.clear();
            }
            task.acceptance_criteria.push(AcceptanceCriterion {
                id: uuid::Uuid::now_v7().to_string(),
                content: requirement.to_string(),
                satisfied: false,
                evidence: Vec::new(),
            });
            task.plan_revision = None;
            task.plan_updated_at = None;
            task.plan_issues.clear();
            task.task_nodes = vec![TaskNode {
                id: uuid::Uuid::now_v7().to_string(),
                plan_key: "ROOT".into(),
                content: requirement.to_string(),
                dependencies: Vec::new(),
                related_files: Vec::new(),
                read_set: Vec::new(),
                write_set: Vec::new(),
                consumes: Vec::new(),
                produces: Vec::new(),
                acceptance_criteria: vec![requirement.to_string()],
                verification_commands: Vec::new(),
                status: TaskNodeStatus::Running,
                priority: "high".into(),
                attempt: 1,
                started_at: Some(chrono::Utc::now().to_rfc3339()),
                completed_at: None,
                failure: None,
            }];
            PhaseDecision {
                next_phase: TaskPhase::Discovering,
                reason: "已接收补充要求，Agent 正在重新分析影响并执行".into(),
                blocker: None,
            }
        }
        OrchestratorEvent::ImplementationFinished => {
            if !matches!(
                task.phase,
                TaskPhase::Discovering | TaskPhase::Implementing | TaskPhase::Repairing
            ) {
                return Err("只有实现或修复阶段可以报告代码写入完成".into());
            }
            let plan_errors = task
                .plan_issues
                .iter()
                .filter(|issue| issue.severity == PlanIssueSeverity::Error)
                .map(|issue| issue.message.clone())
                .collect::<Vec<_>>();
            let unfinished = task
                .task_nodes
                .iter()
                .filter(|node| node.status != TaskNodeStatus::Success)
                .map(|node| node.plan_key.clone())
                .collect::<Vec<_>>();
            if !plan_errors.is_empty() {
                let attempts = count_ledger_events(root, task_id, "plan_correction_requested");
                if attempts < DEFAULT_MAX_PLAN_REVISIONS {
                    task.next_action = Some(TaskNextAction::RevisePlan);
                    workflow_ledger = Some((
                        "plan_correction_requested",
                        None,
                        format!("请求自动修订执行计划：{}", plan_errors.join("；")),
                    ));
                    PhaseDecision {
                        next_phase: TaskPhase::Implementing,
                        reason: format!(
                            "执行计划需要自动修订（{}/{DEFAULT_MAX_PLAN_REVISIONS}）",
                            attempts + 1
                        ),
                        blocker: None,
                    }
                } else {
                    PhaseDecision {
                        next_phase: TaskPhase::Blocked,
                        reason: "执行计划多次校验失败".into(),
                        blocker: Some(format!(
                            "执行计划连续 {attempts} 次存在结构错误：{}",
                            plan_errors.join("；")
                        )),
                    }
                }
            } else if task.plan_revision.is_some() {
                let unplanned = change_set
                    .changes
                    .iter()
                    .filter(|change| !task::plan_covers_path(&task, &change.path))
                    .map(|change| change.path.clone())
                    .collect::<Vec<_>>();
                if !unplanned.is_empty() {
                    let attempts = count_ledger_events(root, task_id, "plan_correction_requested");
                    if attempts < DEFAULT_MAX_PLAN_REVISIONS {
                        task.plan_issues.push(crate::coding::task::PlanIssue {
                            severity: PlanIssueSeverity::Error,
                            code: "unplanned_write".into(),
                            message: format!("实际变更超出计划写入范围：{}", unplanned.join("、")),
                            node_keys: Vec::new(),
                        });
                        task.next_action = Some(TaskNextAction::RevisePlan);
                        workflow_ledger = Some((
                            "plan_correction_requested",
                            None,
                            format!("需要把实际变更纳入计划：{}", unplanned.join("、")),
                        ));
                        PhaseDecision {
                            next_phase: TaskPhase::Implementing,
                            reason: "检测到计划外变更，正在自动修订执行范围".into(),
                            blocker: None,
                        }
                    } else {
                        PhaseDecision {
                            next_phase: TaskPhase::Blocked,
                            reason: "计划写入范围多次与实际变更不一致".into(),
                            blocker: Some(format!(
                                "无法在 {DEFAULT_MAX_PLAN_REVISIONS} 次修订内覆盖实际变更：{}",
                                unplanned.join("、")
                            )),
                        }
                    }
                } else if !unfinished.is_empty() {
                    match schedule_next_node(&mut task) {
                        Ok(node_key) => {
                            task.next_action = Some(TaskNextAction::ContinueNode);
                            workflow_ledger = Some((
                                "node_scheduled",
                                Some(node_key.clone()),
                                format!("已调度节点“{node_key}”进入下一执行回合"),
                            ));
                            PhaseDecision {
                                next_phase: TaskPhase::Implementing,
                                reason: format!(
                                    "继续执行节点 {node_key}，剩余 {} 个节点",
                                    unfinished.len()
                                ),
                                blocker: None,
                            }
                        }
                        Err(reason) => PhaseDecision {
                            next_phase: TaskPhase::Blocked,
                            reason: "执行图无法继续调度".into(),
                            blocker: Some(format!(
                                "{reason}。已保留现场，请检查节点拆解或实现方向。"
                            )),
                        },
                    }
                } else if changed_file_count == 0 {
                    PhaseDecision {
                        next_phase: TaskPhase::Blocked,
                        reason: "实现阶段结束但没有代码变更".into(),
                        blocker: Some(
                            "Agent 结束了实现但没有写入任何文件。请检查是否只在会话里返回了示例代码。"
                                .into(),
                        ),
                    }
                } else {
                    verification::clear_records(root, task_id)?;
                    diagnostics::save_snapshot(root, task_id, &[])?;
                    PhaseDecision {
                        next_phase: TaskPhase::Verifying,
                        reason: format!("已产生 {changed_file_count} 个文件变更，开始验证"),
                        blocker: None,
                    }
                }
            } else if changed_file_count > 2 {
                PhaseDecision {
                    next_phase: TaskPhase::Blocked,
                    reason: "复杂变更缺少结构化执行计划".into(),
                    blocker: Some(format!(
                        "本轮修改了 {changed_file_count} 个文件，但 Agent 未发布可追踪的执行计划。已保留文件变更，请补充要求后让 Agent 先拆解依赖再继续。"
                    )),
                }
            } else if changed_file_count == 0 {
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
                if task.plan_revision.is_none() {
                    for node in &mut task.task_nodes {
                        node.status = TaskNodeStatus::Success;
                        node.completed_at = Some(chrono::Utc::now().to_rfc3339());
                    }
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
                TaskPhase::Verifying | TaskPhase::Delivered | TaskPhase::Blocked
            ) {
                return Err("只有验证中、待验收、已完成或已阻塞的任务可以启动验证".into());
            }
            if changeset::load(root, task_id).committed_hash.is_some() {
                return Err("该任务已提交到 Git，交付证据已封存".into());
            }
            // Validate and bind the batch before clearing prior evidence. If
            // there are no current changes, starting verification must not
            // destroy the last useful report as a side effect.
            changeset::mark_verification_started(root, task_id)?;
            verification::clear_records(root, task_id)?;
            diagnostics::save_snapshot(root, task_id, &[])?;
            for criterion in &mut task.acceptance_criteria {
                criterion.satisfied = false;
                criterion.evidence.clear();
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
                let mut missing = missing_detected_commands(root, &records);
                missing.extend(missing_planned_commands(&task, &records));
                missing.sort();
                missing.dedup();
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
            if verdict.next_phase == TaskPhase::Delivered {
                // Bind all green verification evidence to the exact file
                // revision that produced it. A later external edit clears this
                // marker during native change-set synchronization.
                changeset::mark_verified_revision(root, task_id)?;
            }
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

    if decision.next_phase == TaskPhase::Delivered {
        for node in &mut task.task_nodes {
            node.status = TaskNodeStatus::Success;
            node.completed_at
                .get_or_insert_with(|| chrono::Utc::now().to_rfc3339());
        }
        let verification_records = verification::list_records(root, task_id);
        let passed_records = latest_per_command(&verification_records)
            .into_iter()
            .filter(|record| record.status == VerificationStatus::Passed)
            .collect::<Vec<_>>();
        let evidence = passed_records
            .iter()
            .map(|record| format!("{} 通过（退出码 0）", record.command))
            .collect::<Vec<_>>();
        let commands_by_node = task
            .task_nodes
            .iter()
            .map(|node| (node.plan_key.clone(), node.verification_commands.clone()))
            .collect::<std::collections::HashMap<_, _>>();
        let structured_plan = task.plan_revision.is_some();
        for criterion in &mut task.acceptance_criteria {
            let node_key = criterion.id.split_once(":acceptance:").map(|(key, _)| key);
            let node_evidence = node_key
                .and_then(|key| commands_by_node.get(key))
                .map(|commands| {
                    passed_records
                        .iter()
                        .filter(|record| commands.contains(&record.command))
                        .map(|record| format!("{} 通过（退出码 0）", record.command))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_else(|| evidence.clone());
            criterion.evidence = if node_evidence.is_empty() && !structured_plan {
                vec!["当前工程未检测到可运行的自动检查；已完成变更同步与结构校验".into()]
            } else {
                node_evidence
            };
            criterion.satisfied = !criterion.evidence.is_empty();
        }
    }
    task.phase = decision.next_phase;
    task.phase_reason = Some(decision.reason.clone());
    task.blocker = decision.blocker.clone();
    task::save(root, &task)?;
    // Return the persisted copy so its updatedAt exactly matches subsequent
    // reads. The frontend uses that revision to de-duplicate automatic
    // verification; returning the pre-save timestamp can start the same batch
    // twice after refresh.
    let persisted = task::load(root, task_id).ok_or_else(|| "任务保存后无法读取".to_string())?;
    let _ = task::append_ledger(
        root,
        task_id,
        event_kind,
        None,
        decision.reason.clone(),
        persisted.plan_revision.clone(),
    );
    if let Some((kind, node_key, message)) = workflow_ledger {
        let _ = task::append_ledger(
            root,
            task_id,
            kind,
            node_key,
            message,
            persisted.plan_revision.clone(),
        );
    }
    Ok((persisted, decision))
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
) -> Result<CodingTask, String> {
    let root = access.require_workspace(&root)?;
    apply_and_emit(app, root, task_id, OrchestratorEvent::RequirementSubmitted).await
}

#[tauri::command]
pub async fn coding_task_sync_plan(
    app: AppHandle,
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
    entries: Vec<RuntimePlanEntry>,
) -> Result<CodingTask, String> {
    let root = access.require_workspace(&root)?;
    let synchronized = tokio::task::spawn_blocking({
        let root = root.clone();
        let task_id = task_id.clone();
        move || task::sync_runtime_plan(&root, &task_id, entries)
    })
    .await
    .map_err(|error| format!("同步执行计划失败：{error}"))??;
    if synchronized
        .plan_issues
        .iter()
        .any(|issue| issue.severity == PlanIssueSeverity::Error)
    {
        return Ok(synchronized);
    }
    apply_and_emit(app, root, task_id, OrchestratorEvent::PlanSynchronized).await
}

#[tauri::command]
pub async fn coding_task_execution_ledger(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
) -> Result<Vec<ExecutionLedgerEvent>, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || task::execution_ledger(&root, &task_id))
        .await
        .map_err(|error| format!("读取执行账本失败：{error}"))
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
    requirement: String,
) -> Result<CodingTask, String> {
    let root = access.require_workspace(&root)?;
    apply_and_emit(
        app,
        root,
        task_id,
        OrchestratorEvent::FollowupStarted { requirement },
    )
    .await
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
    changeset::sync_changes(&root, &task_id).await?;
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
    // Close the external-editor race: verification only becomes delivery
    // evidence when the workspace still matches the revision captured at the
    // start of this batch.
    changeset::sync_changes(&root, &task_id).await?;
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
mod tests_v2 {
    use super::*;
    use crate::coding::task::RuntimePlanEntry;
    use crate::coding::verification::{record_from_parts, VerificationKind};

    fn record(command: &str, exit: i32) -> VerificationRecord {
        record_from_parts(
            "task-1",
            VerificationKind::Test,
            command,
            Some(exit),
            String::new(),
            String::new(),
            10,
            false,
            false,
        )
    }

    #[test]
    fn fresh_green_batch_delivers_without_a_manual_acceptance_phase() {
        let decision =
            decide_after_verification(&[record("pnpm build", 0), record("pnpm test", 0)], 3);
        assert_eq!(decision.next_phase, TaskPhase::Delivered);
        assert_eq!(decision.reason, "任务已完成，2 项自动检查通过");
        assert!(decision.blocker.is_none());
    }

    #[test]
    fn failed_or_zero_change_batches_cannot_deliver() {
        assert_eq!(
            decide_after_verification(&[record("pnpm test", 1)], 2).next_phase,
            TaskPhase::Diagnosing
        );
        let unchanged = decide_after_verification(&[record("pnpm test", 0)], 0);
        assert_eq!(unchanged.next_phase, TaskPhase::Blocked);
        assert!(unchanged
            .blocker
            .as_deref()
            .unwrap()
            .contains("没有产生任何代码变更"));
    }

    #[test]
    fn requirement_enters_discovery_and_starts_the_root_node() {
        let dir = tempfile::tempdir().unwrap();
        let task = task::create_task(dir.path(), "task", "implement it").unwrap();
        let (started, decision) = apply(
            dir.path(),
            &task.id,
            OrchestratorEvent::RequirementSubmitted,
        )
        .unwrap();
        assert_eq!(decision.next_phase, TaskPhase::Discovering);
        assert_eq!(started.task_nodes[0].status, TaskNodeStatus::Running);
        assert_eq!(started.task_nodes[0].attempt, 1);
        assert_eq!(
            started.updated_at,
            task::load(dir.path(), &task.id).unwrap().updated_at
        );
        assert!(task::execution_ledger(dir.path(), &task.id)
            .iter()
            .any(|entry| entry.kind == "requirement_submitted"));
    }

    #[test]
    fn verification_execution_errors_leave_a_recoverable_blocked_task() {
        let dir = tempfile::tempdir().unwrap();
        let mut task = task::create_task(dir.path(), "task", "implement it").unwrap();
        task.phase = TaskPhase::Verifying;
        task::save(dir.path(), &task).unwrap();

        let (blocked, decision) = apply(
            dir.path(),
            &task.id,
            OrchestratorEvent::StartFailed {
                reason: "verification command could not start".into(),
            },
        )
        .unwrap();

        assert_eq!(decision.next_phase, TaskPhase::Blocked);
        assert_eq!(decision.reason, "验证执行中断");
        assert_eq!(
            blocked.blocker.as_deref(),
            Some("verification command could not start")
        );
    }

    #[test]
    fn structured_plan_automatically_schedules_unfinished_nodes() {
        let dir = tempfile::tempdir().unwrap();
        let task = task::create_task(dir.path(), "task", "implement it").unwrap();
        changeset::capture_filesystem_baseline(dir.path(), &task.id).unwrap();
        apply(
            dir.path(),
            &task.id,
            OrchestratorEvent::RequirementSubmitted,
        )
        .unwrap();
        task::sync_runtime_plan(
            dir.path(),
            &task.id,
            vec![RuntimePlanEntry {
                key: "T1".into(),
                content: "write code".into(),
                dependencies: vec![],
                related_files: vec!["result.txt".into()],
                read_set: vec![],
                write_set: vec!["result.txt".into()],
                consumes: vec![],
                produces: vec![],
                acceptance_criteria: vec!["result exists".into()],
                verification_commands: vec!["test -f result.txt".into()],
                status: TaskNodeStatus::Pending,
                priority: "high".into(),
            }],
        )
        .unwrap();
        apply(dir.path(), &task.id, OrchestratorEvent::PlanSynchronized).unwrap();
        std::fs::write(dir.path().join("result.txt"), "done\n").unwrap();
        changeset::sync_from_filesystem(dir.path(), &task.id).unwrap();
        let (scheduled, decision) = apply(
            dir.path(),
            &task.id,
            OrchestratorEvent::ImplementationFinished,
        )
        .unwrap();
        assert_eq!(decision.next_phase, TaskPhase::Implementing);
        assert_eq!(scheduled.next_action, Some(TaskNextAction::ContinueNode));
        assert_eq!(scheduled.task_nodes[0].status, TaskNodeStatus::Running);
        assert_eq!(scheduled.task_nodes[0].attempt, 1);
        assert!(task::execution_ledger(dir.path(), &task.id)
            .iter()
            .any(|entry| entry.kind == "node_scheduled"));
    }

    #[test]
    fn structured_plan_requires_every_declared_verification_command() {
        let dir = tempfile::tempdir().unwrap();
        let mut task = task::create_task(dir.path(), "task", "implement it").unwrap();
        task.task_nodes[0].verification_commands = vec!["pnpm test -- unit".into()];
        let records = vec![record("pnpm build", 0)];
        assert_eq!(
            missing_planned_commands(&task, &records),
            ["pnpm test -- unit"]
        );
        assert!(missing_planned_commands(&task, &[record("pnpm test -- unit", 0)]).is_empty());
    }

    #[test]
    fn actual_writes_force_replan_before_verification_and_can_recover() {
        let dir = tempfile::tempdir().unwrap();
        let task = task::create_task(dir.path(), "task", "implement it").unwrap();
        changeset::capture_filesystem_baseline(dir.path(), &task.id).unwrap();
        apply(
            dir.path(),
            &task.id,
            OrchestratorEvent::RequirementSubmitted,
        )
        .unwrap();
        let plan = |write_set: Vec<String>| RuntimePlanEntry {
            key: "T1".into(),
            content: "write code".into(),
            dependencies: vec![],
            related_files: write_set.clone(),
            read_set: vec![],
            write_set,
            consumes: vec![],
            produces: vec![],
            acceptance_criteria: vec!["result exists".into()],
            verification_commands: vec!["test -f extra.txt".into()],
            status: TaskNodeStatus::Success,
            priority: "high".into(),
        };
        task::sync_runtime_plan(dir.path(), &task.id, vec![plan(vec!["planned.txt".into()])])
            .unwrap();
        apply(dir.path(), &task.id, OrchestratorEvent::PlanSynchronized).unwrap();
        std::fs::write(dir.path().join("extra.txt"), "done\n").unwrap();
        changeset::sync_from_filesystem(dir.path(), &task.id).unwrap();

        let (replan, decision) = apply(
            dir.path(),
            &task.id,
            OrchestratorEvent::ImplementationFinished,
        )
        .unwrap();
        assert_eq!(decision.next_phase, TaskPhase::Implementing);
        assert_eq!(replan.next_action, Some(TaskNextAction::RevisePlan));
        assert!(replan
            .plan_issues
            .iter()
            .any(|issue| issue.code == "unplanned_write"));

        task::sync_runtime_plan(dir.path(), &task.id, vec![plan(vec!["extra.txt".into()])])
            .unwrap();
        apply(dir.path(), &task.id, OrchestratorEvent::PlanSynchronized).unwrap();
        let (ready, decision) = apply(
            dir.path(),
            &task.id,
            OrchestratorEvent::ImplementationFinished,
        )
        .unwrap();
        assert_eq!(decision.next_phase, TaskPhase::Verifying);
        assert!(ready.next_action.is_none());
    }

    #[test]
    fn node_scheduler_stops_after_bounded_no_progress_retries() {
        let dir = tempfile::tempdir().unwrap();
        let mut task = task::create_task(dir.path(), "task", "implement it").unwrap();
        task.task_nodes[0].plan_key = "T1".into();
        task.task_nodes[0].attempt = DEFAULT_MAX_NODE_ATTEMPTS;
        task.task_nodes[0].status = TaskNodeStatus::Running;
        let error = schedule_next_node(&mut task).unwrap_err();
        assert!(error.contains("连续执行 3 次"));
    }

    #[test]
    fn followup_reopens_terminal_task_as_the_same_agent_workflow() {
        let dir = tempfile::tempdir().unwrap();
        let mut task = task::create_task(dir.path(), "task", "implement it").unwrap();
        task.phase = TaskPhase::Delivered;
        task::save(dir.path(), &task).unwrap();
        let (reopened, decision) = apply(
            dir.path(),
            &task.id,
            OrchestratorEvent::FollowupStarted {
                requirement: "add regression test".into(),
            },
        )
        .unwrap();
        assert_eq!(decision.next_phase, TaskPhase::Discovering);
        assert_eq!(reopened.task_nodes[0].plan_key, "ROOT");
        assert_eq!(reopened.task_nodes[0].status, TaskNodeStatus::Running);
        assert!(reopened
            .acceptance_criteria
            .iter()
            .any(|criterion| criterion.content == "add regression test"));
    }

    #[test]
    fn identical_repair_failures_stop_instead_of_looping() {
        let mut problem =
            crate::coding::diagnostics::parse_record(&record("pnpm test", 1)).remove(0);
        problem.fingerprint = "same".into();
        let decision = next_after_repair(&[problem], &["same".into()], 1, 3);
        assert_eq!(decision.next_phase, TaskPhase::Blocked);
        assert!(decision.blocker.as_deref().unwrap().contains("相同错误"));
    }
}
