//! Quality gates, delivery report and Git handoff.
//!
//! Every gate verdict is derived from stored evidence: exit codes, the change
//! set, review marks and acceptance evidence. A gate a project cannot run (no
//! lint script, for instance) reports as not-applicable rather than pretending
//! that a check ran. Automatic and human-reviewed completion remain distinct.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::coding::changeset::{self, ChangeSet, FileChange, FileChangeView};
use crate::coding::diagnostics::{self, Problem};
use crate::coding::orchestrator::{self, RepairRound};
use crate::coding::task::{self, AcceptanceCriterion, CodingTask, TaskNodeStatus, TaskPhase};
use crate::coding::verification::{self, VerificationKind, VerificationRecord, VerificationStatus};
use crate::shell_fs::FilesystemAccess;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum GateId {
    Build,
    Test,
    Lint,
    TypeCheck,
    VerificationFreshness,
    DiffReview,
    Acceptance,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum GateStatus {
    Satisfied,
    NotSatisfied,
    /// The project has no such check; nothing was verified and nothing failed.
    NotApplicable,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct QualityGate {
    pub id: GateId,
    pub title: String,
    pub status: GateStatus,
    pub summary: String,
    pub evidence: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceEntry {
    pub criterion_id: String,
    pub kind: String,
    pub detail: String,
    pub source: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryReport {
    pub task: CodingTask,
    pub gates: Vec<QualityGate>,
    pub changes: Vec<FileChangeView>,
    pub total_added: u32,
    pub total_removed: u32,
    pub verifications: Vec<VerificationRecord>,
    pub problems: Vec<Problem>,
    pub repair_rounds: Vec<RepairRound>,
    pub evidence: Vec<EvidenceEntry>,
    pub blockers: Vec<String>,
    /// True only when no gate is NotSatisfied.
    pub deliverable: bool,
}

fn title_for(id: GateId) -> &'static str {
    match id {
        GateId::Build => "构建通过",
        GateId::Test => "测试通过",
        GateId::Lint => "静态检查通过",
        GateId::TypeCheck => "类型检查通过",
        GateId::VerificationFreshness => "验证对应当前代码",
        GateId::DiffReview => "变更已审阅",
        GateId::Acceptance => "验收标准已核销",
    }
}

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

fn verification_gate(
    id: GateId,
    kind: VerificationKind,
    records: &[VerificationRecord],
) -> QualityGate {
    let effective = latest_per_command(records);
    let relevant: Vec<&&VerificationRecord> = effective
        .iter()
        .filter(|record| record.kind == kind)
        .collect();

    if relevant.is_empty() {
        return QualityGate {
            id,
            title: title_for(id).into(),
            status: GateStatus::NotApplicable,
            summary: "当前工程未识别到该类检查命令".into(),
            evidence: Vec::new(),
        };
    }
    let failing_count = relevant
        .iter()
        .filter(|record| record.status != VerificationStatus::Passed)
        .count();
    let evidence: Vec<String> = relevant
        .iter()
        .map(|record| {
            let verdict = match record.status {
                VerificationStatus::Passed => "通过",
                VerificationStatus::Failed => "失败",
                VerificationStatus::TimedOut => "超时",
                VerificationStatus::Cancelled => "已取消",
                VerificationStatus::Running => "执行中",
            };
            let detail = record
                .test_summary
                .map(|summary| {
                    format!(
                        "，{} 通过 / {} 失败 / {} 跳过",
                        summary.passed, summary.failed, summary.skipped
                    )
                })
                .unwrap_or_default();
            format!(
                "{}：{verdict}（退出码 {}）{detail}",
                record.command,
                record
                    .exit_code
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "无".into())
            )
        })
        .collect();

    QualityGate {
        id,
        title: title_for(id).into(),
        status: if failing_count == 0 {
            GateStatus::Satisfied
        } else {
            GateStatus::NotSatisfied
        },
        summary: if failing_count == 0 {
            format!("{} 项检查全部通过", relevant.len())
        } else {
            format!("{failing_count} 项检查未通过")
        },
        evidence,
    }
}

pub fn evaluate_gates(
    records: &[VerificationRecord],
    set: &ChangeSet,
    criteria: &[AcceptanceCriterion],
    problems: &[Problem],
    review_required: bool,
) -> Vec<QualityGate> {
    let mut gates = vec![
        verification_gate(GateId::Build, VerificationKind::Build, records),
        verification_gate(GateId::Test, VerificationKind::Test, records),
        verification_gate(GateId::Lint, VerificationKind::Lint, records),
        verification_gate(GateId::TypeCheck, VerificationKind::TypeCheck, records),
    ];

    let verification_current = set.verification_is_current();
    gates.push(QualityGate {
        id: GateId::VerificationFreshness,
        title: title_for(GateId::VerificationFreshness).into(),
        status: if verification_current {
            GateStatus::Satisfied
        } else {
            GateStatus::NotSatisfied
        },
        summary: if verification_current {
            "最近一次验证与当前文件内容一致".into()
        } else {
            "文件在最近一次验证后发生变化，请重新运行验证".into()
        },
        evidence: Vec::new(),
    });

    let task_changes: Vec<&FileChange> = set.changes.iter().collect();
    let unreviewed_count = task_changes
        .iter()
        .filter(|change| !set.is_reviewed(&change.path))
        .count();
    gates.push(QualityGate {
        id: GateId::DiffReview,
        title: title_for(GateId::DiffReview).into(),
        status: if !review_required {
            GateStatus::NotApplicable
        } else if task_changes.is_empty() || unreviewed_count > 0 {
            GateStatus::NotSatisfied
        } else {
            GateStatus::Satisfied
        },
        summary: if !review_required {
            "任务使用自动完成模式，未要求人工审阅".into()
        } else if task_changes.is_empty() {
            "本任务没有产生代码变更".into()
        } else if unreviewed_count == 0 {
            format!("{} 个变更文件已全部审阅", task_changes.len())
        } else {
            format!("还有 {unreviewed_count} 个变更文件未审阅")
        },
        evidence: task_changes
            .iter()
            .map(|change| format!("{} (+{} -{})", change.path, change.added, change.removed))
            .collect(),
    });

    let unmet_count = criteria
        .iter()
        .filter(|criterion| !criterion.satisfied || criterion.evidence.is_empty())
        .count();
    gates.push(QualityGate {
        id: GateId::Acceptance,
        title: title_for(GateId::Acceptance).into(),
        status: if !review_required {
            GateStatus::NotApplicable
        } else if criteria.is_empty() || unmet_count > 0 {
            GateStatus::NotSatisfied
        } else {
            GateStatus::Satisfied
        },
        summary: if !review_required {
            "任务使用自动完成模式，未要求人工验收".into()
        } else if criteria.is_empty() {
            "尚未生成验收标准".into()
        } else if unmet_count == 0 {
            format!("{} 条验收标准均有验证证据", criteria.len())
        } else {
            format!("还有 {unmet_count} 条验收标准缺少验证证据")
        },
        evidence: criteria
            .iter()
            .map(|criterion| {
                format!(
                    "{}：{}",
                    criterion.content,
                    if criterion.evidence.is_empty() {
                        "无证据".to_string()
                    } else {
                        criterion.evidence.join("；")
                    }
                )
            })
            .collect(),
    });

    if !problems.is_empty() {
        if let Some(gate) = gates.iter_mut().find(|gate| gate.id == GateId::Test) {
            gate.evidence
                .push(format!("诊断中心仍有 {} 个未解决问题", problems.len()));
        }
    }
    gates
}

pub fn is_deliverable(gates: &[QualityGate]) -> bool {
    gates
        .iter()
        .all(|gate| gate.status != GateStatus::NotSatisfied)
}

pub fn committable_paths(set: &ChangeSet) -> Vec<String> {
    set.changes
        .iter()
        .map(|change| change.path.clone())
        .collect()
}

/// Structured input a model turns into a commit message. It describes the full
/// task change set; the commit command separately refuses dirty-at-start files.
pub fn commit_message_input(
    name: &str,
    requirement: &str,
    set: &ChangeSet,
    records: &[VerificationRecord],
) -> String {
    let files = set
        .changes
        .iter()
        .map(|change| {
            format!(
                "- {} ({:?}, +{} -{})",
                change.path, change.kind, change.added, change.removed
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let verifications = latest_per_command(records)
        .iter()
        .map(|record| format!("- {}：{:?}", record.command, record.status))
        .collect::<Vec<_>>()
        .join("\n");
    [
        format!("任务名称：{name}"),
        format!("原始需求：{requirement}"),
        "变更文件：".to_string(),
        if files.is_empty() {
            "- 无".into()
        } else {
            files
        },
        "验证结果：".to_string(),
        if verifications.is_empty() {
            "- 未执行".into()
        } else {
            verifications
        },
    ]
    .join("\n")
}

pub fn build_report(root: &Path, task_id: &str) -> Result<DeliveryReport, String> {
    let task = task::load(root, task_id).ok_or_else(|| "任务不存在".to_string())?;
    let set = changeset::load(root, task_id);
    let records = verification::list_records(root, task_id);
    let problems = diagnostics::load_snapshot(root, task_id);
    let gates = evaluate_gates(
        &records,
        &set,
        &task.acceptance_criteria,
        &problems,
        task.review_required,
    );
    let evidence = task
        .acceptance_criteria
        .iter()
        .flat_map(|criterion| {
            criterion
                .evidence
                .iter()
                .map(|detail| EvidenceEntry {
                    criterion_id: criterion.id.clone(),
                    kind: "acceptance".into(),
                    detail: detail.clone(),
                    source: if detail.contains("用户已确认") || detail.contains("逐一审阅")
                    {
                        "human_review".into()
                    } else {
                        "verification".into()
                    },
                })
                .collect::<Vec<_>>()
        })
        .collect();
    let blockers = gates
        .iter()
        .filter(|gate| gate.status == GateStatus::NotSatisfied)
        .map(|gate| format!("{}：{}", gate.title, gate.summary))
        .collect();
    Ok(DeliveryReport {
        total_added: set.total_added(),
        total_removed: set.total_removed(),
        changes: set.changes.iter().map(FileChangeView::from).collect(),
        deliverable: is_deliverable(&gates),
        gates,
        verifications: records,
        problems,
        repair_rounds: orchestrator::repair_rounds(root, task_id),
        evidence,
        blockers,
        task,
    })
}

/// Complete a task that is waiting at the delivery boundary. Manual-review
/// tasks require content-bound diff evidence; legacy automatic tasks that were
/// persisted in `gating` are completed without manufacturing review evidence.
pub fn finalize_delivery(root: &Path, task_id: &str) -> Result<DeliveryReport, String> {
    let mut task = task::load(root, task_id).ok_or_else(|| "任务不存在".to_string())?;
    if task.phase != TaskPhase::Gating {
        return Err("只有进入交付门禁的任务可以确认交付".into());
    }
    let set = changeset::load(root, task_id);
    changeset::ensure_head_unchanged(root, &set)?;
    changeset::ensure_changes_current(root, &set)?;
    if !set.rollback_unsafe_files.is_empty() {
        return Err(format!(
            "以下文件没有安全快照，不能交付：{}",
            set.rollback_unsafe_files.join("、")
        ));
    }
    let records = verification::list_records(root, task_id);
    let problems = diagnostics::load_snapshot(root, task_id);
    let gates = evaluate_gates(
        &records,
        &set,
        &task.acceptance_criteria,
        &problems,
        task.review_required,
    );
    let blockers: Vec<String> = gates
        .iter()
        .filter(|gate| gate.id != GateId::Acceptance && gate.status == GateStatus::NotSatisfied)
        .map(|gate| format!("{}：{}", gate.title, gate.summary))
        .collect();
    if !blockers.is_empty() {
        return Err(format!("交付门禁尚未通过：{}", blockers.join("；")));
    }
    if !problems.is_empty() {
        return Err(format!("诊断中心仍有 {} 个未解决问题", problems.len()));
    }

    if task.review_required {
        let mut evidence: Vec<String> = latest_per_command(&records)
            .into_iter()
            .filter(|record| record.status == VerificationStatus::Passed)
            .map(|record| format!("{} 通过（退出码 0）", record.command))
            .collect();
        evidence.push(format!("{} 个任务差异已逐一审阅", set.changes.len()));
        evidence.push("用户已确认当前任务满足验收要求".into());
        if records.is_empty() {
            evidence.push("当前工程未检测到可运行的自动检查，由用户完成差异验收".into());
        }
        for criterion in &mut task.acceptance_criteria {
            criterion.satisfied = true;
            criterion.evidence = evidence.clone();
        }
    }
    let related_files: Vec<String> = set
        .changes
        .iter()
        .map(|change| change.path.clone())
        .collect();
    for node in &mut task.task_nodes {
        node.status = TaskNodeStatus::Success;
        node.related_files = related_files.clone();
    }
    task.phase = TaskPhase::Delivered;
    task.phase_reason = Some(if task.review_required {
        "用户已确认验收，任务可以交付".into()
    } else if records.is_empty() {
        "任务已完成；当前工程未检测到可运行的自动检查".into()
    } else {
        format!(
            "任务已完成，{} 项自动检查通过",
            latest_per_command(&records).len()
        )
    });
    task.blocker = None;
    task::save(root, &task)?;
    build_report(root, task_id)
}

async fn git(root: &PathBuf, arguments: &[&str]) -> Result<String, String> {
    let output = tokio::process::Command::new("git")
        .args(arguments)
        .current_dir(root)
        .output()
        .await
        .map_err(|error| format!("执行 git 失败：{error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn unexpected_staged_paths(staged: &str, allowed: &[String]) -> Vec<String> {
    let allowed: std::collections::BTreeSet<&str> = allowed.iter().map(String::as_str).collect();
    let mut unexpected: Vec<String> = staged
        .split('\0')
        .filter(|path| !path.is_empty() && !allowed.contains(path))
        .map(str::to_owned)
        .collect();
    unexpected.sort();
    unexpected.dedup();
    unexpected
}

async fn ensure_no_unrelated_staged_changes(
    root: &PathBuf,
    task_paths: &[String],
) -> Result<(), String> {
    let staged = git(root, &["diff", "--cached", "--name-only", "-z", "--"]).await?;
    let unexpected = unexpected_staged_paths(&staged, task_paths);
    if unexpected.is_empty() {
        return Ok(());
    }
    Err(format!(
        "Git 暂存区包含当前任务之外的变更，为避免混入本次提交，请先提交或取消暂存：{}",
        unexpected.join("、")
    ))
}

#[tauri::command]
pub async fn coding_delivery_report(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
) -> Result<DeliveryReport, String> {
    let root = access.require_workspace(&root)?;
    changeset::sync_changes(&root, &task_id).await?;
    tokio::task::spawn_blocking(move || build_report(&root, &task_id))
        .await
        .map_err(|error| format!("生成交付报告失败：{error}"))?
}

#[tauri::command]
pub async fn coding_delivery_finalize(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
) -> Result<DeliveryReport, String> {
    let root = access.require_workspace(&root)?;
    // Delivery evidence must describe the bytes that are on disk now, not the
    // last Agent-stream edge observed by the renderer.
    changeset::sync_changes(&root, &task_id).await?;
    tokio::task::spawn_blocking(move || finalize_delivery(&root, &task_id))
        .await
        .map_err(|error| format!("确认交付失败：{error}"))?
}

#[tauri::command]
pub async fn coding_delivery_commit_input(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
) -> Result<String, String> {
    let root = access.require_workspace(&root)?;
    changeset::sync_changes(&root, &task_id).await?;
    tokio::task::spawn_blocking(move || {
        let task = task::load(&root, &task_id).ok_or_else(|| "任务不存在".to_string())?;
        Ok(commit_message_input(
            &task.name,
            &task.requirement,
            &changeset::load(&root, &task_id),
            &verification::list_records(&root, &task_id),
        ))
    })
    .await
    .map_err(|error| format!("生成提交信息输入失败：{error}"))?
}

#[tauri::command]
pub async fn coding_delivery_pr_input(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
) -> Result<DeliveryReport, String> {
    // A PR description needs exactly the report's content; reuse it rather than
    // maintaining a second aggregation path.
    coding_delivery_report(access, root, task_id).await
}

/// Stage only this task's files and commit them. Never `git add -A`, so a
/// user's unrelated uncommitted work is never swept into the task's commit.
#[tauri::command]
pub async fn coding_git_commit(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
    message: String,
) -> Result<String, String> {
    let root = access.require_workspace(&root)?;
    let trimmed = message.trim().to_string();
    if trimmed.is_empty() {
        return Err("提交信息不能为空".into());
    }
    // Revalidate review hashes immediately before staging. A file changed in
    // an external editor after delivery must return the task to review instead
    // of being silently swept into the commit.
    changeset::sync_changes(&root, &task_id).await?;
    let set = {
        let root = root.clone();
        let task_id = task_id.clone();
        tokio::task::spawn_blocking(move || changeset::load(&root, &task_id))
            .await
            .map_err(|error| format!("读取变更集失败：{error}"))?
    };
    if set.committed_hash.is_some() {
        return Err("该任务已经提交".into());
    }
    if set.effective_baseline_mode() == changeset::BaselineMode::Filesystem {
        return Err(
            "当前任务使用本地检查点，不支持应用内 Git 提交；可手工提交，或初始化 Git 并新建任务后使用提交功能".into(),
        );
    }
    changeset::ensure_head_unchanged(&root, &set)?;
    changeset::ensure_changes_current(&root, &set)?;
    let report = {
        let report_root = root.clone();
        let report_task_id = task_id.clone();
        tokio::task::spawn_blocking(move || build_report(&report_root, &report_task_id))
            .await
            .map_err(|error| format!("读取交付门禁失败：{error}"))??
    };
    if report.task.phase != TaskPhase::Delivered || !report.deliverable {
        return Err("任务尚未通过交付门禁，不能提交".into());
    }
    let overlapping: Vec<String> = set
        .changes
        .iter()
        .filter(|change| change.pre_existing)
        .map(|change| change.path.clone())
        .collect();
    if !overlapping.is_empty() {
        return Err(format!(
            "以下文件在任务开始前已有未提交修改，为避免将用户改动混入提交，请先手工整理：{}",
            overlapping.join("、")
        ));
    }
    let paths = committable_paths(&set);
    if paths.is_empty() {
        return Err("本任务没有可提交的变更".into());
    }
    for path in &paths {
        // Validate path components rather than rejecting harmless names such
        // as `range..test.ts`. `git add --` below then treats leading dashes as
        // paths too, never command options.
        changeset::resolve_in_workspace(&root, path)?;
    }
    // `git commit` includes the entire index, not just files staged by the
    // command below. Refuse a mixed index rather than silently committing
    // unrelated work owned by the user or another tool.
    ensure_no_unrelated_staged_changes(&root, &paths).await?;
    let mut add_arguments: Vec<&str> = vec!["add", "--"];
    add_arguments.extend(paths.iter().map(|path| path.as_str()));
    git(&root, &add_arguments).await?;
    // Close the practical race window if another process staged a file while
    // this task's own paths were being added.
    ensure_no_unrelated_staged_changes(&root, &paths).await?;
    git(&root, &["commit", "-m", &trimmed]).await?;
    let hash = git(&root, &["rev-parse", "HEAD"]).await?.trim().to_string();
    let mark_root = root.clone();
    let mark_task = task_id.clone();
    let mark_hash = hash.clone();
    tokio::task::spawn_blocking(move || {
        changeset::mark_committed(&mark_root, &mark_task, &mark_hash)
    })
    .await
    .map_err(|error| format!("记录提交结果失败：{error}"))??;
    Ok(hash)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coding::changeset::ChangeKind;
    use crate::coding::verification::record_from_parts;

    fn record(kind: VerificationKind, command: &str, exit: i32) -> VerificationRecord {
        record_from_parts(
            "task-1",
            kind,
            command,
            Some(exit),
            String::new(),
            String::new(),
            10,
            false,
            false,
        )
    }

    fn change_set(reviewed: bool) -> ChangeSet {
        ChangeSet {
            task_id: "task-1".into(),
            baseline_files: Vec::new(),
            changes: vec![FileChange {
                path: "src/a.ts".into(),
                kind: ChangeKind::Modified,
                added: 10,
                removed: 2,
                baseline_content: Some("old".into()),
                pre_existing: false,
            }],
            created_at: "2026-09-11T00:00:00Z".into(),
            reviewed_files: if reviewed {
                vec!["src/a.ts".to_string()]
            } else {
                Vec::new()
            },
            reviewed_hashes: if reviewed {
                std::collections::BTreeMap::from([("src/a.ts".to_string(), "v1".to_string())])
            } else {
                std::collections::BTreeMap::new()
            },
            change_hashes: std::collections::BTreeMap::from([(
                "src/a.ts".to_string(),
                "v1".to_string(),
            )]),
            ..ChangeSet::default()
        }
    }

    fn criteria(satisfied: bool) -> Vec<AcceptanceCriterion> {
        vec![AcceptanceCriterion {
            id: "ac1".into(),
            content: "登录流程可用".into(),
            satisfied,
            evidence: if satisfied {
                vec!["pnpm test 通过".to_string()]
            } else {
                Vec::new()
            },
        }]
    }

    #[test]
    fn missing_command_kind_is_not_applicable_not_failure() {
        let gates = evaluate_gates(
            &[record(VerificationKind::Test, "pnpm test", 0)],
            &change_set(true),
            &criteria(true),
            &[],
            true,
        );
        let lint = gates.iter().find(|gate| gate.id == GateId::Lint).unwrap();
        assert_eq!(lint.status, GateStatus::NotApplicable);
        assert!(is_deliverable(&gates));
    }

    #[test]
    fn failing_test_makes_gate_not_satisfied_and_blocks_delivery() {
        let gates = evaluate_gates(
            &[record(VerificationKind::Test, "pnpm test", 1)],
            &change_set(true),
            &criteria(true),
            &[],
            true,
        );
        let test = gates.iter().find(|gate| gate.id == GateId::Test).unwrap();
        assert_eq!(test.status, GateStatus::NotSatisfied);
        assert!(!is_deliverable(&gates));
    }

    #[test]
    fn acceptance_without_evidence_is_not_satisfied() {
        let gates = evaluate_gates(
            &[record(VerificationKind::Test, "pnpm test", 0)],
            &change_set(true),
            &criteria(false),
            &[],
            true,
        );
        let acceptance = gates
            .iter()
            .find(|gate| gate.id == GateId::Acceptance)
            .unwrap();
        assert_eq!(acceptance.status, GateStatus::NotSatisfied);
        assert!(!is_deliverable(&gates));
    }

    #[test]
    fn unreviewed_changes_fail_diff_review_gate() {
        let gates = evaluate_gates(
            &[record(VerificationKind::Test, "pnpm test", 0)],
            &change_set(false),
            &criteria(true),
            &[],
            true,
        );
        let review = gates
            .iter()
            .find(|gate| gate.id == GateId::DiffReview)
            .unwrap();
        assert_eq!(review.status, GateStatus::NotSatisfied);
        assert!(review.summary.contains('1'));
    }

    #[test]
    fn empty_change_set_fails_diff_review() {
        let empty = ChangeSet {
            task_id: "task-1".into(),
            baseline_files: Vec::new(),
            changes: Vec::new(),
            created_at: "2026-09-11T00:00:00Z".into(),
            reviewed_files: Vec::new(),
            ..ChangeSet::default()
        };
        let gates = evaluate_gates(
            &[record(VerificationKind::Test, "pnpm test", 0)],
            &empty,
            &criteria(true),
            &[],
            true,
        );
        let review = gates
            .iter()
            .find(|gate| gate.id == GateId::DiffReview)
            .unwrap();
        assert_eq!(review.status, GateStatus::NotSatisfied);
    }

    #[test]
    fn latest_run_of_a_command_decides_its_gate() {
        let gates = evaluate_gates(
            &[
                record(VerificationKind::Build, "pnpm build", 1),
                record(VerificationKind::Build, "pnpm build", 0),
            ],
            &change_set(true),
            &criteria(true),
            &[],
            true,
        );
        let build = gates.iter().find(|gate| gate.id == GateId::Build).unwrap();
        assert_eq!(build.status, GateStatus::Satisfied);
    }

    #[test]
    fn new_tasks_require_verification_for_the_current_content_revision() {
        let mut set = change_set(true);
        set.baseline_mode = Some(changeset::BaselineMode::Filesystem);
        let stale = evaluate_gates(&[], &set, &criteria(true), &[], true);
        assert_eq!(
            stale
                .iter()
                .find(|gate| gate.id == GateId::VerificationFreshness)
                .unwrap()
                .status,
            GateStatus::NotSatisfied
        );

        set.verified_revision = Some(set.content_revision());
        let current = evaluate_gates(&[], &set, &criteria(true), &[], true);
        assert_eq!(
            current
                .iter()
                .find(|gate| gate.id == GateId::VerificationFreshness)
                .unwrap()
                .status,
            GateStatus::Satisfied
        );
    }

    #[test]
    fn unrelated_pre_staged_files_are_detected_before_commit() {
        let allowed = vec!["src/task.ts".to_string(), "src/range..test.ts".to_string()];
        assert_eq!(
            unexpected_staged_paths(
                "src/task.ts\0docs/user-notes.md\0src/range..test.ts\0",
                &allowed,
            ),
            vec!["docs/user-notes.md".to_string()]
        );
    }

    #[test]
    fn all_gate_kinds_are_always_reported() {
        let gates = evaluate_gates(&[], &change_set(true), &criteria(true), &[], true);
        for id in [
            GateId::Build,
            GateId::Test,
            GateId::Lint,
            GateId::TypeCheck,
            GateId::VerificationFreshness,
            GateId::DiffReview,
            GateId::Acceptance,
        ] {
            assert!(gates.iter().any(|gate| gate.id == id), "缺少门禁 {id:?}");
        }
    }

    #[test]
    fn automatic_mode_does_not_fabricate_review_or_acceptance() {
        let gates = evaluate_gates(
            &[record(VerificationKind::Test, "pnpm test", 0)],
            &change_set(false),
            &criteria(false),
            &[],
            false,
        );
        assert_eq!(
            gates
                .iter()
                .find(|gate| gate.id == GateId::DiffReview)
                .unwrap()
                .status,
            GateStatus::NotApplicable
        );
        assert_eq!(
            gates
                .iter()
                .find(|gate| gate.id == GateId::Acceptance)
                .unwrap()
                .status,
            GateStatus::NotApplicable
        );
        assert!(is_deliverable(&gates));
    }

    #[test]
    fn commit_message_input_lists_every_reviewed_task_change() {
        let mut set = change_set(true);
        set.changes.push(FileChange {
            path: "src/user-edit.ts".into(),
            kind: ChangeKind::Modified,
            added: 3,
            removed: 1,
            baseline_content: Some("x".into()),
            pre_existing: true,
        });
        let input = commit_message_input("重构登录", "把登录改成 OIDC", &set, &[]);
        assert!(input.contains("src/a.ts"));
        assert!(input.contains("src/user-edit.ts"));
    }

    #[test]
    fn commit_paths_describe_the_complete_task_change_set() {
        let mut set = change_set(true);
        set.changes.push(FileChange {
            path: "src/user-edit.ts".into(),
            kind: ChangeKind::Modified,
            added: 3,
            removed: 1,
            baseline_content: Some("x".into()),
            pre_existing: true,
        });
        let paths = committable_paths(&set);
        assert_eq!(
            paths,
            vec!["src/a.ts".to_string(), "src/user-edit.ts".to_string()]
        );
    }
}
