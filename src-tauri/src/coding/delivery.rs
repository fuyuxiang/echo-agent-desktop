//! Quality gates, delivery report and Git handoff.
//!
//! Every gate verdict is derived from stored evidence: exit codes, the change
//! set, review marks and acceptance evidence. A gate a project cannot run (no
//! lint script, for instance) reports as not-applicable rather than silently
//! passing, so a green report always means something was actually checked.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::coding::changeset::{self, ChangeSet, FileChange};
use crate::coding::diagnostics::{self, Problem};
use crate::coding::orchestrator::{self, RepairRound};
use crate::coding::task::{self, AcceptanceCriterion, CodingTask};
use crate::coding::verification::{self, VerificationKind, VerificationRecord, VerificationStatus};
use crate::shell_fs::FilesystemAccess;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum GateId {
    Build,
    Test,
    Lint,
    TypeCheck,
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
    pub changes: Vec<FileChange>,
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
) -> Vec<QualityGate> {
    let mut gates = vec![
        verification_gate(GateId::Build, VerificationKind::Build, records),
        verification_gate(GateId::Test, VerificationKind::Test, records),
        verification_gate(GateId::Lint, VerificationKind::Lint, records),
        verification_gate(GateId::TypeCheck, VerificationKind::TypeCheck, records),
    ];

    let task_changes: Vec<&FileChange> = set
        .changes
        .iter()
        .filter(|change| !change.pre_existing)
        .collect();
    let unreviewed_count = task_changes
        .iter()
        .filter(|change| !set.reviewed_files.iter().any(|path| path == &change.path))
        .count();
    gates.push(QualityGate {
        id: GateId::DiffReview,
        title: title_for(GateId::DiffReview).into(),
        status: if task_changes.is_empty() || unreviewed_count > 0 {
            GateStatus::NotSatisfied
        } else {
            GateStatus::Satisfied
        },
        summary: if task_changes.is_empty() {
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
        status: if criteria.is_empty() || unmet_count > 0 {
            GateStatus::NotSatisfied
        } else {
            GateStatus::Satisfied
        },
        summary: if criteria.is_empty() {
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
        .filter(|change| !change.pre_existing)
        .map(|change| change.path.clone())
        .collect()
}

/// Structured input a model turns into a commit message. Deliberately excludes
/// files the user had already modified so the message never claims them.
pub fn commit_message_input(
    name: &str,
    requirement: &str,
    set: &ChangeSet,
    records: &[VerificationRecord],
) -> String {
    let files = set
        .changes
        .iter()
        .filter(|change| !change.pre_existing)
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
    let gates = evaluate_gates(&records, &set, &task.acceptance_criteria, &problems);
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
                    source: "verification".into(),
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
        changes: set.changes.clone(),
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

#[tauri::command]
pub async fn coding_delivery_report(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
) -> Result<DeliveryReport, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || build_report(&root, &task_id))
        .await
        .map_err(|error| format!("生成交付报告失败：{error}"))?
}

#[tauri::command]
pub async fn coding_delivery_commit_input(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
) -> Result<String, String> {
    let root = access.require_workspace(&root)?;
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
    let set = {
        let root = root.clone();
        let task_id = task_id.clone();
        tokio::task::spawn_blocking(move || changeset::load(&root, &task_id))
            .await
            .map_err(|error| format!("读取变更集失败：{error}"))?
    };
    let paths = committable_paths(&set);
    if paths.is_empty() {
        return Err("本任务没有可提交的变更".into());
    }
    for path in &paths {
        if path.starts_with('/') || path.contains("..") {
            return Err(format!("非法的提交路径：{path}"));
        }
    }
    let mut add_arguments: Vec<&str> = vec!["add", "--"];
    add_arguments.extend(paths.iter().map(|path| path.as_str()));
    git(&root, &add_arguments).await?;
    git(&root, &["commit", "-m", &trimmed]).await?;
    git(&root, &["rev-parse", "HEAD"])
        .await
        .map(|hash| hash.trim().to_string())
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
        };
        let gates = evaluate_gates(
            &[record(VerificationKind::Test, "pnpm test", 0)],
            &empty,
            &criteria(true),
            &[],
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
        );
        let build = gates.iter().find(|gate| gate.id == GateId::Build).unwrap();
        assert_eq!(build.status, GateStatus::Satisfied);
    }

    #[test]
    fn all_gate_kinds_are_always_reported() {
        let gates = evaluate_gates(&[], &change_set(true), &criteria(true), &[]);
        for id in [
            GateId::Build,
            GateId::Test,
            GateId::Lint,
            GateId::TypeCheck,
            GateId::DiffReview,
            GateId::Acceptance,
        ] {
            assert!(gates.iter().any(|gate| gate.id == id), "缺少门禁 {id:?}");
        }
    }

    #[test]
    fn commit_message_input_lists_only_task_changes() {
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
        // A file the user had already edited must not be attributed to this task.
        assert!(!input.contains("src/user-edit.ts"));
    }

    #[test]
    fn commit_paths_exclude_pre_existing_files() {
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
        assert_eq!(paths, vec!["src/a.ts".to_string()]);
    }
}
