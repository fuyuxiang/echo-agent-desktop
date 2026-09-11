//! Verification engine: detect a project's real build / lint / type-check /
//! test commands, run them, and turn their output into structured records.
//!
//! A verification's pass/fail verdict comes from the process exit code alone.
//! Output parsing only enriches a record with a test summary; when parsing
//! fails the record is still trustworthy, just marked as unstructured.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::coding::store;
use crate::coding_workspace::{high_risk_command_reason, CodingProcesses};
use crate::shell_fs::FilesystemAccess;

const MAX_OUTPUT_BYTES: usize = 512 * 1024;
const DEFAULT_TIMEOUT_SECS: u64 = 300;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum VerificationKind {
    Build,
    Lint,
    TypeCheck,
    Test,
    Custom,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum VerificationStatus {
    Running,
    Passed,
    Failed,
    TimedOut,
    Cancelled,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TestSummary {
    pub total: u32,
    pub passed: u32,
    pub failed: u32,
    pub skipped: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DetectedCommand {
    pub kind: VerificationKind,
    pub command: String,
    pub label: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VerificationRecord {
    pub id: String,
    pub task_id: String,
    pub kind: VerificationKind,
    pub command: String,
    pub status: VerificationStatus,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    pub started_at: String,
    pub finished_at: String,
    pub test_summary: Option<TestSummary>,
    /// False when the output could not be parsed into a summary, so the UI can
    /// say so instead of implying a clean structured result.
    pub structured: bool,
}

fn records_path(root: &Path, task_id: &str) -> PathBuf {
    store::task_dir(root, task_id).join("verifications.jsonl")
}

pub fn append_record(root: &Path, record: &VerificationRecord) -> Result<(), String> {
    store::append_jsonl(&records_path(root, &record.task_id), record)
}

pub fn list_records(root: &Path, task_id: &str) -> Vec<VerificationRecord> {
    store::read_jsonl(&records_path(root, task_id))
}

fn label_for(kind: VerificationKind) -> &'static str {
    match kind {
        VerificationKind::Build => "构建",
        VerificationKind::Lint => "静态检查",
        VerificationKind::TypeCheck => "类型检查",
        VerificationKind::Test => "测试",
        VerificationKind::Custom => "命令",
    }
}

/// Detect the project's real verification commands from its manifests. Only
/// commands that actually exist are returned, so the orchestrator never invents
/// a script the project does not define.
pub fn detect_commands(root: &Path) -> Vec<DetectedCommand> {
    let mut detected: Vec<DetectedCommand> = Vec::new();
    let mut push = |detected: &mut Vec<DetectedCommand>, kind: VerificationKind, command: String| {
        if !detected.iter().any(|entry| entry.command == command) {
            detected.push(DetectedCommand {
                kind,
                label: label_for(kind).to_string(),
                command,
            });
        }
    };

    if let Some(manifest) = std::fs::read_to_string(root.join("package.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
    {
        let runner = if root.join("pnpm-lock.yaml").exists() {
            "pnpm"
        } else if root.join("yarn.lock").exists() {
            "yarn"
        } else {
            "npm run"
        };
        if let Some(scripts) = manifest.get("scripts").and_then(|value| value.as_object()) {
            for (name, kind) in [
                ("build", VerificationKind::Build),
                ("lint", VerificationKind::Lint),
                ("typecheck", VerificationKind::TypeCheck),
                ("type-check", VerificationKind::TypeCheck),
                ("tsc", VerificationKind::TypeCheck),
                ("test", VerificationKind::Test),
            ] {
                if scripts.contains_key(name) {
                    push(&mut detected, kind, format!("{runner} {name}"));
                }
            }
        }
    }

    if root.join("Cargo.toml").exists() {
        push(&mut detected, VerificationKind::Build, "cargo build".into());
        push(&mut detected, VerificationKind::Lint, "cargo clippy".into());
        push(&mut detected, VerificationKind::Test, "cargo test".into());
    }
    if root.join("pom.xml").exists() {
        push(
            &mut detected,
            VerificationKind::Build,
            "mvn -B compile".into(),
        );
        push(&mut detected, VerificationKind::Test, "mvn -B test".into());
    }
    if root.join("build.gradle").exists() || root.join("build.gradle.kts").exists() {
        push(&mut detected, VerificationKind::Build, "gradle build".into());
        push(&mut detected, VerificationKind::Test, "gradle test".into());
    }
    if root.join("pyproject.toml").exists() || root.join("requirements.txt").exists() {
        push(&mut detected, VerificationKind::Test, "pytest".into());
        if root.join("mypy.ini").exists() || root.join("pyproject.toml").exists() {
            push(&mut detected, VerificationKind::TypeCheck, "mypy .".into());
        }
    }
    if root.join("go.mod").exists() {
        push(
            &mut detected,
            VerificationKind::Build,
            "go build ./...".into(),
        );
        push(&mut detected, VerificationKind::Lint, "go vet ./...".into());
        push(&mut detected, VerificationKind::Test, "go test ./...".into());
    }
    detected
}

fn capture(text: &str, pattern: &str, group: usize) -> Option<u32> {
    regex::Regex::new(pattern)
        .ok()?
        .captures(text)?
        .get(group)?
        .as_str()
        .parse()
        .ok()
}

/// Parse a test runner's summary line. Returns `None` when no known shape is
/// present; callers must not treat that as zero tests.
pub fn parse_test_output(output: &str) -> Option<TestSummary> {
    // JUnit / Maven: "Tests run: 24, Failures: 2, Errors: 1, Skipped: 3"
    if let Some(total) = capture(output, r"Tests run:\s*(\d+)", 1) {
        let failures = capture(output, r"Failures:\s*(\d+)", 1).unwrap_or(0);
        let errors = capture(output, r"Errors:\s*(\d+)", 1).unwrap_or(0);
        let skipped = capture(output, r"Skipped:\s*(\d+)", 1).unwrap_or(0);
        let failed = failures + errors;
        return Some(TestSummary {
            total,
            failed,
            skipped,
            passed: total.saturating_sub(failed + skipped),
        });
    }
    // cargo: "test result: FAILED. 8 passed; 2 failed; 1 ignored"
    if output.contains("test result:") {
        let passed = capture(output, r"(\d+)\s+passed", 1).unwrap_or(0);
        let failed = capture(output, r"(\d+)\s+failed", 1).unwrap_or(0);
        let skipped = capture(output, r"(\d+)\s+ignored", 1).unwrap_or(0);
        return Some(TestSummary {
            total: passed + failed + skipped,
            passed,
            failed,
            skipped,
        });
    }
    // vitest prints two tallies — "Test Files 2 passed" then "Tests 42 passed".
    // Prefer the case-level line so the file count is never mistaken for it.
    let case_line = output
        .lines()
        .find(|line| {
            let trimmed = line.trim_start();
            trimmed.starts_with("Tests ") && !trimmed.starts_with("Test Files")
        })
        .map(|line| line.to_string());
    let scope = case_line.as_deref().unwrap_or(output);

    // pytest / vitest: "3 failed, 12 passed, 2 skipped"
    if let Some(passed) = capture(scope, r"(\d+)\s+passed", 1) {
        let failed = capture(scope, r"(\d+)\s+failed", 1).unwrap_or(0);
        let skipped = capture(scope, r"(\d+)\s+skipped", 1).unwrap_or(0);
        return Some(TestSummary {
            total: passed + failed + skipped,
            passed,
            failed,
            skipped,
        });
    }
    None
}

/// Build a record from finished process parts. Extracted so the exit-code-only
/// verdict rule is unit-testable without spawning a process.
#[allow(clippy::too_many_arguments)]
pub fn record_from_parts(
    task_id: &str,
    kind: VerificationKind,
    command: &str,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    duration_ms: u64,
    timed_out: bool,
    cancelled: bool,
) -> VerificationRecord {
    let status = if cancelled {
        VerificationStatus::Cancelled
    } else if timed_out {
        VerificationStatus::TimedOut
    } else if exit_code == Some(0) {
        VerificationStatus::Passed
    } else {
        VerificationStatus::Failed
    };
    let combined = format!("{stdout}\n{stderr}");
    let test_summary = matches!(kind, VerificationKind::Test)
        .then(|| parse_test_output(&combined))
        .flatten();
    VerificationRecord {
        id: uuid::Uuid::now_v7().to_string(),
        task_id: task_id.to_string(),
        kind,
        command: command.to_string(),
        status,
        exit_code,
        stdout,
        stderr,
        duration_ms,
        started_at: chrono::Utc::now().to_rfc3339(),
        finished_at: chrono::Utc::now().to_rfc3339(),
        structured: test_summary.is_some(),
        test_summary,
    }
}

fn truncate_output(mut text: String) -> String {
    if text.len() > MAX_OUTPUT_BYTES {
        let tail = text.split_off(text.len() - MAX_OUTPUT_BYTES);
        return format!("…较早输出已省略…\n{tail}");
    }
    text
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct VerificationChunk {
    run_id: String,
    stream: &'static str,
    chunk: String,
}

/// Run one verification command inside the workspace. Streams output to the UI
/// and honours the same native high-risk command policy as the rest of the app.
pub async fn run(
    app: AppHandle,
    processes: &CodingProcesses,
    root: PathBuf,
    task_id: String,
    kind: VerificationKind,
    command: String,
    timeout_secs: Option<u64>,
) -> Result<VerificationRecord, String> {
    let command_text = command.trim().to_string();
    if command_text.is_empty() {
        return Err("命令不能为空".into());
    }
    if let Some(reason) = high_risk_command_reason(&command_text, &root) {
        return Err(format!("命令被原生安全策略拒绝：{reason}"));
    }
    let run_id = uuid::Uuid::now_v7().to_string();
    let cancellation = CancellationToken::new();
    processes.register(&run_id, cancellation.clone())?;

    let mut builder = if cfg!(target_os = "windows") {
        let mut builder = Command::new("cmd");
        builder.args(["/D", "/S", "/C", &command_text]);
        builder
    } else {
        let mut builder = Command::new("sh");
        builder.args(["-lc", &command_text]);
        builder
    };
    builder
        .current_dir(&root)
        .env("CI", "true")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    builder.process_group(0);

    let started = Instant::now();
    let mut child = builder.spawn().map_err(|error| {
        processes.unregister(&run_id);
        format!("无法执行命令：{error}")
    })?;
    let stdout = child.stdout.take().ok_or("无法捕获标准输出")?;
    let stderr = child.stderr.take().ok_or("无法捕获错误输出")?;

    let stdout_task = {
        let app = app.clone();
        let run_id = run_id.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            let mut buffer = String::new();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app.emit(
                    "coding://verification-output",
                    VerificationChunk {
                        run_id: run_id.clone(),
                        stream: "stdout",
                        chunk: format!("{line}\n"),
                    },
                );
                buffer.push_str(&line);
                buffer.push('\n');
            }
            buffer
        })
    };
    let stderr_task = {
        let app = app.clone();
        let run_id = run_id.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            let mut buffer = String::new();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app.emit(
                    "coding://verification-output",
                    VerificationChunk {
                        run_id: run_id.clone(),
                        stream: "stderr",
                        chunk: format!("{line}\n"),
                    },
                );
                buffer.push_str(&line);
                buffer.push('\n');
            }
            buffer
        })
    };

    let timeout = std::time::Duration::from_secs(
        timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS).clamp(5, 1_800),
    );
    let mut timed_out = false;
    let mut cancelled = false;
    let exit_status = tokio::select! {
        status = child.wait() => status.ok(),
        _ = tokio::time::sleep(timeout) => {
            timed_out = true;
            let _ = child.start_kill();
            child.wait().await.ok()
        }
        _ = cancellation.cancelled() => {
            cancelled = true;
            let _ = child.start_kill();
            child.wait().await.ok()
        }
    };

    processes.unregister(&run_id);
    let stdout_text = truncate_output(stdout_task.await.unwrap_or_default());
    let stderr_text = truncate_output(stderr_task.await.unwrap_or_default());
    let record = record_from_parts(
        &task_id,
        kind,
        &command_text,
        exit_status.and_then(|status| status.code()),
        stdout_text,
        stderr_text,
        started.elapsed().as_millis() as u64,
        timed_out,
        cancelled,
    );
    let write_root = root.clone();
    let write_record = record.clone();
    tokio::task::spawn_blocking(move || append_record(&write_root, &write_record))
        .await
        .map_err(|error| format!("写入验证记录失败：{error}"))??;
    let _ = app.emit("coding://verification-updated", &record);
    Ok(record)
}

#[tauri::command]
pub async fn coding_verification_detect(
    access: State<'_, FilesystemAccess>,
    root: String,
) -> Result<Vec<DetectedCommand>, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || detect_commands(&root))
        .await
        .map_err(|error| format!("识别验证命令失败：{error}"))
}

#[tauri::command]
pub async fn coding_verification_list(
    access: State<'_, FilesystemAccess>,
    root: String,
    task_id: String,
) -> Result<Vec<VerificationRecord>, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || list_records(&root, &task_id))
        .await
        .map_err(|error| format!("读取验证记录失败：{error}"))
}

#[tauri::command]
pub async fn coding_verification_run(
    app: AppHandle,
    access: State<'_, FilesystemAccess>,
    processes: State<'_, CodingProcesses>,
    root: String,
    task_id: String,
    kind: VerificationKind,
    command: String,
    timeout_secs: Option<u64>,
) -> Result<VerificationRecord, String> {
    let root = access.require_workspace(&root)?;
    run(app, &processes, root, task_id, kind, command, timeout_secs).await
}

#[tauri::command]
pub async fn coding_verification_cancel(
    processes: State<'_, CodingProcesses>,
    run_id: String,
) -> Result<(), String> {
    processes.cancel(&run_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("coding-verify-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn detects_npm_scripts_by_kind() {
        let root = temp_root();
        std::fs::write(
            root.join("package.json"),
            r#"{"scripts":{"build":"tsc --noEmit && vite build","lint":"eslint .","test":"vitest run"}}"#,
        )
        .unwrap();
        let detected = detect_commands(&root);
        assert!(detected
            .iter()
            .any(|entry| entry.kind == VerificationKind::Build && entry.command.contains("build")));
        assert!(detected
            .iter()
            .any(|entry| entry.kind == VerificationKind::Lint && entry.command.contains("lint")));
        assert!(detected
            .iter()
            .any(|entry| entry.kind == VerificationKind::Test && entry.command.contains("test")));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn detects_cargo_and_maven_projects() {
        let root = temp_root();
        std::fs::write(root.join("Cargo.toml"), "[package]\nname = \"demo\"\n").unwrap();
        let detected = detect_commands(&root);
        assert!(detected.iter().any(|entry| entry.command == "cargo build"));
        assert!(detected.iter().any(|entry| entry.command == "cargo test"));
        std::fs::remove_dir_all(&root).ok();

        let maven = temp_root();
        std::fs::write(maven.join("pom.xml"), "<project></project>").unwrap();
        let detected = detect_commands(&maven);
        assert!(detected.iter().any(|entry| entry.command.starts_with("mvn")));
        std::fs::remove_dir_all(&maven).ok();
    }

    #[test]
    fn parses_vitest_summary() {
        let summary =
            parse_test_output("Test Files  2 passed (2)\n Tests  42 passed | 1 skipped (43)")
                .expect("vitest output should parse");
        assert_eq!(summary.passed, 42);
        assert_eq!(summary.skipped, 1);
        assert_eq!(summary.failed, 0);
    }

    #[test]
    fn parses_pytest_and_junit_and_cargo_summaries() {
        let pytest = parse_test_output("=== 3 failed, 12 passed, 2 skipped in 4.21s ===").unwrap();
        assert_eq!(pytest.failed, 3);
        assert_eq!(pytest.passed, 12);
        assert_eq!(pytest.skipped, 2);

        let junit = parse_test_output("Tests run: 24, Failures: 2, Errors: 1, Skipped: 3").unwrap();
        assert_eq!(junit.total, 24);
        assert_eq!(junit.failed, 3);
        assert_eq!(junit.skipped, 3);

        let cargo =
            parse_test_output("test result: FAILED. 8 passed; 2 failed; 1 ignored").unwrap();
        assert_eq!(cargo.passed, 8);
        assert_eq!(cargo.failed, 2);
        assert_eq!(cargo.skipped, 1);
    }

    #[test]
    fn vitest_file_tally_is_not_mistaken_for_case_tally() {
        // "Test Files 2 passed" appears before "Tests 42 passed"; reading the
        // first match would report 2 cases instead of 42.
        let summary = parse_test_output(
            "\n Test Files  2 passed (2)\n      Tests  42 passed (42)\n   Duration  1.20s\n",
        )
        .unwrap();
        assert_eq!(summary.passed, 42);
        assert_eq!(summary.total, 42);
    }

    #[test]
    fn unparseable_output_yields_none() {
        assert!(parse_test_output("Compiling demo v0.1.0\nFinished in 3s").is_none());
    }

    #[test]
    fn status_follows_exit_code_not_output_text() {
        // Output that reads like success must not override a non-zero exit code.
        let record = record_from_parts(
            "task-1",
            VerificationKind::Test,
            "pnpm test",
            Some(1),
            "All tests passed!".into(),
            String::new(),
            120,
            false,
            false,
        );
        assert_eq!(record.status, VerificationStatus::Failed);

        let passing = record_from_parts(
            "task-1",
            VerificationKind::Build,
            "pnpm build",
            Some(0),
            String::new(),
            "warning: unused import".into(),
            80,
            false,
            false,
        );
        assert_eq!(passing.status, VerificationStatus::Passed);
    }

    #[test]
    fn timeout_and_cancel_are_distinct_from_failure() {
        let timed_out = record_from_parts(
            "task-1",
            VerificationKind::Test,
            "pnpm test",
            None,
            String::new(),
            String::new(),
            300_000,
            true,
            false,
        );
        assert_eq!(timed_out.status, VerificationStatus::TimedOut);

        let cancelled = record_from_parts(
            "task-1",
            VerificationKind::Test,
            "pnpm test",
            None,
            String::new(),
            String::new(),
            500,
            false,
            true,
        );
        assert_eq!(cancelled.status, VerificationStatus::Cancelled);
    }

    #[test]
    fn records_append_and_reload_in_order() {
        let root = temp_root();
        for index in 0..3 {
            let record = record_from_parts(
                "task-1",
                VerificationKind::Test,
                &format!("cmd-{index}"),
                Some(0),
                String::new(),
                String::new(),
                10,
                false,
                false,
            );
            append_record(&root, &record).unwrap();
        }
        let records = list_records(&root, "task-1");
        assert_eq!(records.len(), 3);
        assert_eq!(records[0].command, "cmd-0");
        assert_eq!(records[2].command, "cmd-2");
        std::fs::remove_dir_all(&root).ok();
    }
}
