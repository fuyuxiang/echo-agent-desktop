//! Native services used by the dedicated Coding Workspace.
//!
//! The renderer may only inspect or execute inside a directory that was
//! granted by the native folder picker/session catalog.  The implementation is
//! intentionally dependency-light: repository discovery is bounded and build
//! commands run in a time-boxed child shell with capped output.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Instant, UNIX_EPOCH};

use base64::Engine as _;
use echo_agent_pty::pty::{PtyChild, PtyConfig, PtyHandle, PtyMaster};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::shell_fs::FilesystemAccess;

const MAX_SCANNED_FILES: usize = 12_000;
const MAX_SCAN_DEPTH: usize = 18;
const MAX_MANIFEST_BYTES: u64 = 512 * 1024;
const MAX_COMMAND_CHARS: usize = 4_096;
const MAX_COMMAND_OUTPUT_BYTES: usize = 768 * 1024;
const MAX_DOCUMENT_BYTES: usize = 4 * 1024 * 1024;
const MAX_GIT_DIFF_BYTES: usize = 2 * 1024 * 1024;
const MAX_SEARCH_RESULTS: usize = 300;
const MAX_SEARCH_PREVIEW_CHARS: usize = 600;

const IGNORED_DIRECTORIES: &[&str] = &[
    ".git",
    ".idea",
    ".vscode",
    "node_modules",
    "target",
    "dist",
    "build",
    "coverage",
    ".next",
    ".nuxt",
    ".venv",
    "venv",
    "__pycache__",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingLanguageStat {
    language: String,
    files: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingModule {
    name: String,
    path: String,
    kind: String,
    dependencies: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingWorkspaceAnalysis {
    root: String,
    name: String,
    project_type: String,
    file_count: usize,
    truncated: bool,
    languages: Vec<CodingLanguageStat>,
    modules: Vec<CodingModule>,
    validation_commands: Vec<String>,
    has_git: bool,
    git_branch: Option<String>,
    git_changed_files: usize,
    instruction_files: Vec<String>,
    scanned_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingGitFile {
    path: String,
    old_path: Option<String>,
    status: String,
    staged: bool,
    unstaged: bool,
    untracked: bool,
    added: usize,
    removed: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingGitSnapshot {
    has_git: bool,
    branch: Option<String>,
    head: Option<String>,
    files: Vec<CodingGitFile>,
    total_added: usize,
    total_removed: usize,
    captured_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingDocument {
    path: String,
    relative_path: String,
    content: String,
    hash: String,
    size: usize,
    modified_at: u128,
    language: String,
    line_ending: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingSearchHit {
    path: String,
    line: usize,
    column: usize,
    preview: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingWriteDocumentRequest {
    root: String,
    path: String,
    content: String,
    expected_hash: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingCreateEntryRequest {
    root: String,
    parent: Option<String>,
    name: String,
    directory: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingRunCommandRequest {
    run_id: Option<String>,
    root: String,
    command: String,
    timeout_secs: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingCommandResult {
    run_id: String,
    command: String,
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    duration_ms: u128,
    timed_out: bool,
    cancelled: bool,
    truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodingCommandOutputEvent {
    run_id: String,
    stream: String,
    data: String,
}

#[derive(Default)]
pub struct CodingProcesses {
    commands: Mutex<HashMap<String, CancellationToken>>,
    terminals: Mutex<HashMap<String, Arc<CodingTerminalSession>>>,
}

impl CodingProcesses {
    pub fn new() -> Self {
        Self::default()
    }

    /// Track a running command so it can be cancelled by id. Shared with the
    /// verification engine, which is the single owner of command execution.
    pub fn register(&self, run_id: &str, token: CancellationToken) -> Result<(), String> {
        let mut commands = self
            .commands
            .lock()
            .map_err(|_| "命令运行状态已损坏".to_string())?;
        if commands.contains_key(run_id) {
            return Err("命令运行标识已存在".into());
        }
        commands.insert(run_id.to_string(), token);
        Ok(())
    }

    pub fn unregister(&self, run_id: &str) {
        if let Ok(mut commands) = self.commands.lock() {
            commands.remove(run_id);
        }
    }

    pub fn cancel(&self, run_id: &str) -> Result<(), String> {
        let commands = self
            .commands
            .lock()
            .map_err(|_| "命令运行状态已损坏".to_string())?;
        match commands.get(run_id) {
            Some(token) => {
                token.cancel();
                Ok(())
            }
            None => Err("命令已结束或不存在".into()),
        }
    }
}

struct CodingTerminalSession {
    master: PtyMaster,
    child: Mutex<PtyChild>,
    writer: Mutex<Box<dyn Write + Send>>,
}

fn terminate_terminal_child(child: &mut PtyChild) -> Result<(), String> {
    if !child.is_alive() {
        return Ok(());
    }
    let pid = child.pid();
    #[cfg(unix)]
    if let Some(pid) = pid {
        // Shells spawned by portable-pty own the foreground PTY process group.
        // Stopping the group prevents a compiler/test child from surviving a
        // terminal restart or workspace switch.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
        std::thread::sleep(std::time::Duration::from_millis(120));
        if child.is_alive() {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
    }
    #[cfg(target_os = "windows")]
    if let Some(pid) = pid {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    if child.is_alive() {
        child
            .kill()
            .map_err(|error| format!("关闭终端失败：{error}"))?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodingTerminalEvent {
    terminal_id: String,
    data_base64: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingTerminalCreated {
    terminal_id: String,
}

#[derive(Debug, Clone)]
struct ManifestCandidate {
    path: PathBuf,
    kind: &'static str,
}

fn bounded_text(path: &Path) -> Option<String> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_MANIFEST_BYTES
    {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

fn language_for_extension(extension: &str) -> Option<&'static str> {
    match extension.to_ascii_lowercase().as_str() {
        "java" => Some("Java"),
        "kt" | "kts" => Some("Kotlin"),
        "ts" | "tsx" => Some("TypeScript"),
        "js" | "jsx" | "mjs" | "cjs" => Some("JavaScript"),
        "py" => Some("Python"),
        "rs" => Some("Rust"),
        "go" => Some("Go"),
        "cs" => Some("C#"),
        "c" | "h" => Some("C/C++"),
        "cc" | "cpp" | "cxx" | "hpp" => Some("C/C++"),
        "vue" => Some("Vue"),
        "svelte" => Some("Svelte"),
        "php" => Some("PHP"),
        "rb" => Some("Ruby"),
        "sql" => Some("SQL"),
        "html" | "htm" => Some("HTML"),
        "css" | "scss" | "less" => Some("CSS"),
        _ => None,
    }
}

fn manifest_kind(name: &str) -> Option<&'static str> {
    match name {
        "pom.xml" => Some("Maven"),
        "build.gradle" | "build.gradle.kts" => Some("Gradle"),
        "package.json" => Some("Node.js"),
        "pyproject.toml" | "requirements.txt" => Some("Python"),
        "Cargo.toml" => Some("Rust"),
        "go.mod" => Some("Go"),
        "build.sbt" => Some("Scala"),
        _ => None,
    }
}

fn relative_display(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn first_tag(text: &str, tag: &str) -> Option<String> {
    let start_marker = format!("<{tag}>");
    let end_marker = format!("</{tag}>");
    let start = text.find(&start_marker)? + start_marker.len();
    let rest = &text[start..];
    let end = rest.find(&end_marker)?;
    let value = rest[..end].trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn quoted_toml_value(text: &str, key: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let line = line.trim();
        let (left, right) = line.split_once('=')?;
        if left.trim() != key {
            return None;
        }
        let value = right
            .trim()
            .trim_matches(|character| character == '"' || character == '\'');
        (!value.is_empty()).then(|| value.to_string())
    })
}

fn module_name(manifest: &ManifestCandidate, module_root: &Path) -> String {
    let fallback = module_root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("workspace")
        .to_string();
    let Some(text) = bounded_text(&manifest.path) else {
        return fallback;
    };
    match manifest.kind {
        "Node.js" => serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|value| value.get("name")?.as_str().map(str::to_string))
            .unwrap_or(fallback),
        "Maven" => first_tag(&text, "artifactId").unwrap_or(fallback),
        "Rust" | "Python" => quoted_toml_value(&text, "name").unwrap_or(fallback),
        "Go" => text
            .lines()
            .find_map(|line| {
                line.trim()
                    .strip_prefix("module ")
                    .map(str::trim)
                    .map(str::to_string)
            })
            .filter(|value| !value.is_empty())
            .unwrap_or(fallback),
        _ => fallback,
    }
}

fn validation_commands(root: &Path, manifests: &[ManifestCandidate]) -> Vec<String> {
    let mut commands = Vec::new();
    for manifest in manifests {
        let Some(module_root) = manifest.path.parent() else {
            continue;
        };
        let relative_root = relative_display(root, module_root);
        let at_root = module_root == root;
        let quoted_root = format!("\"{}\"", relative_root.replace('"', "\\\""));
        match manifest.kind {
            "Maven" => {
                let wrapper = module_root.join(if cfg!(target_os = "windows") {
                    "mvnw.cmd"
                } else {
                    "mvnw"
                });
                if wrapper.is_file() {
                    commands.push(if at_root {
                        if cfg!(target_os = "windows") {
                            "mvnw.cmd test".into()
                        } else {
                            "./mvnw test".into()
                        }
                    } else {
                        format!("\"{}\" test", relative_display(root, &wrapper))
                    });
                } else if at_root {
                    commands.push("mvn test".into());
                } else {
                    commands.push(format!(
                        "mvn -f \"{}\" test",
                        relative_display(root, &manifest.path)
                    ));
                }
            }
            "Gradle" => {
                let wrapper = module_root.join(if cfg!(target_os = "windows") {
                    "gradlew.bat"
                } else {
                    "gradlew"
                });
                if wrapper.is_file() {
                    commands.push(if at_root {
                        if cfg!(target_os = "windows") {
                            "gradlew.bat test".into()
                        } else {
                            "./gradlew test".into()
                        }
                    } else {
                        format!("\"{}\" test", relative_display(root, &wrapper))
                    });
                } else if at_root {
                    commands.push("gradle test".into());
                } else {
                    commands.push(format!("gradle -p {quoted_root} test"));
                }
            }
            "Node.js" => {
                let scripts = bounded_text(&manifest.path)
                    .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
                    .and_then(|value| value.get("scripts").cloned())
                    .and_then(|value| value.as_object().cloned())
                    .unwrap_or_default();
                let manager = if root.join("pnpm-lock.yaml").is_file()
                    || module_root.join("pnpm-lock.yaml").is_file()
                {
                    "pnpm"
                } else if root.join("yarn.lock").is_file()
                    || module_root.join("yarn.lock").is_file()
                {
                    "yarn"
                } else {
                    "npm"
                };
                for script in ["test", "build", "lint", "typecheck"] {
                    if !scripts.contains_key(script) {
                        continue;
                    }
                    commands.push(match (manager, at_root, script) {
                        ("pnpm", true, _) => format!("pnpm {script}"),
                        ("pnpm", false, _) => format!("pnpm --dir {quoted_root} {script}"),
                        ("yarn", true, _) => format!("yarn {script}"),
                        ("yarn", false, _) => format!("yarn --cwd {quoted_root} {script}"),
                        ("npm", true, "test") => "npm test".into(),
                        ("npm", true, _) => format!("npm run {script}"),
                        ("npm", false, "test") => format!("npm --prefix {quoted_root} test"),
                        ("npm", false, _) => format!("npm --prefix {quoted_root} run {script}"),
                        _ => unreachable!(),
                    });
                }
            }
            "Python" => commands.push(if at_root {
                "pytest".into()
            } else {
                format!("pytest {quoted_root}")
            }),
            "Rust" => commands.push(if at_root {
                "cargo test".into()
            } else {
                format!(
                    "cargo test --manifest-path \"{}\"",
                    relative_display(root, &manifest.path)
                )
            }),
            "Go" => commands.push(if at_root {
                "go test ./...".into()
            } else {
                format!("go -C {quoted_root} test ./...")
            }),
            _ => {}
        }
    }
    commands.sort();
    commands.dedup();
    commands.truncate(24);
    commands
}

async fn git_output(root: &Path, arguments: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(arguments)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

async fn git_output_bytes(root: &Path, arguments: &[&str]) -> Option<Vec<u8>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(arguments)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;
    output.status.success().then_some(output.stdout)
}

fn git_status_label(x: u8, y: u8) -> &'static str {
    if x == b'?' && y == b'?' {
        "untracked"
    } else if x == b'!' && y == b'!' {
        "ignored"
    } else if matches!(x, b'U') || matches!(y, b'U') || (x == b'A' && y == b'A') {
        "conflict"
    } else if matches!(x, b'R' | b'C') || matches!(y, b'R' | b'C') {
        "renamed"
    } else if matches!(x, b'D') || matches!(y, b'D') {
        "deleted"
    } else if matches!(x, b'A') || matches!(y, b'A') {
        "added"
    } else {
        "modified"
    }
}

fn parse_git_numstat(output: &[u8]) -> HashMap<String, (usize, usize)> {
    String::from_utf8_lossy(output)
        .lines()
        .filter_map(|line| {
            let mut columns = line.splitn(3, '\t');
            let added = columns.next()?.parse::<usize>().unwrap_or_default();
            let removed = columns.next()?.parse::<usize>().unwrap_or_default();
            let path = columns.next()?.to_string();
            Some((path, (added, removed)))
        })
        .collect()
}

fn parse_git_status(output: &[u8], stats: &HashMap<String, (usize, usize)>) -> Vec<CodingGitFile> {
    let mut entries = output
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty());
    let mut files = Vec::new();
    while let Some(entry) = entries.next() {
        if entry.len() < 4 {
            continue;
        }
        let x = entry[0];
        let y = entry[1];
        let path = String::from_utf8_lossy(&entry[3..]).into_owned();
        let old_path = if matches!(x, b'R' | b'C') || matches!(y, b'R' | b'C') {
            entries
                .next()
                .map(|value| String::from_utf8_lossy(value).into_owned())
        } else {
            None
        };
        let (added, removed) = stats.get(&path).copied().unwrap_or_default();
        files.push(CodingGitFile {
            path,
            old_path,
            status: git_status_label(x, y).to_string(),
            staged: x != b' ' && x != b'?',
            unstaged: y != b' ' && y != b'?',
            untracked: x == b'?' && y == b'?',
            added,
            removed,
        });
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    files
}

async fn git_snapshot(root: &Path) -> CodingGitSnapshot {
    let has_git = git_output(root, &["rev-parse", "--is-inside-work-tree"])
        .await
        .as_deref()
        == Some("true");
    if !has_git {
        return CodingGitSnapshot {
            has_git: false,
            branch: None,
            head: None,
            files: Vec::new(),
            total_added: 0,
            total_removed: 0,
            captured_at: chrono::Utc::now().to_rfc3339(),
        };
    }
    let status = git_output_bytes(
        root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
    )
    .await
    .unwrap_or_default();
    let numstat = git_output_bytes(root, &["diff", "--numstat", "HEAD", "--"])
        .await
        .unwrap_or_default();
    let stats = parse_git_numstat(&numstat);
    let files = parse_git_status(&status, &stats);
    CodingGitSnapshot {
        has_git: true,
        branch: git_output(root, &["branch", "--show-current"])
            .await
            .filter(|value| !value.is_empty()),
        head: git_output(root, &["rev-parse", "--short=10", "HEAD"])
            .await
            .filter(|value| !value.is_empty()),
        total_added: files.iter().map(|file| file.added).sum(),
        total_removed: files.iter().map(|file| file.removed).sum(),
        files,
        captured_at: chrono::Utc::now().to_rfc3339(),
    }
}

#[tauri::command]
pub async fn coding_git_snapshot(
    access: State<'_, FilesystemAccess>,
    root: String,
) -> Result<CodingGitSnapshot, String> {
    let root = access.require_workspace(&root)?;
    Ok(git_snapshot(&root).await)
}

#[tauri::command]
pub async fn coding_git_diff(
    access: State<'_, FilesystemAccess>,
    root: String,
    path: Option<String>,
) -> Result<String, String> {
    let root = access.require_workspace(&root)?;
    let mut arguments = vec![
        "diff",
        "--no-ext-diff",
        "--no-color",
        "--unified=3",
        "HEAD",
        "--",
    ];
    let normalized_path = path
        .as_deref()
        .map(|value| normalize_git_relative_path(&root, value))
        .transpose()?;
    if let Some(value) = normalized_path.as_deref() {
        arguments.push(value);
    }
    let output = git_output_bytes(&root, &arguments)
        .await
        .unwrap_or_default();
    let mut truncated = output.len() > MAX_GIT_DIFF_BYTES;
    let mut text =
        String::from_utf8_lossy(&output[..output.len().min(MAX_GIT_DIFF_BYTES)]).into_owned();
    if text.is_empty() {
        if let Some(path) = normalized_path.as_deref() {
            let tracked = git_output(&root, &["ls-files", "--error-unmatch", "--", path])
                .await
                .is_some();
            let candidate = root.join(path);
            if !tracked && candidate.is_file() {
                let safe = resolve_coding_document_path(&root, path)?;
                let bytes =
                    std::fs::read(&safe).map_err(|error| format!("无法读取未跟踪文件：{error}"))?;
                truncated = bytes.len() > MAX_GIT_DIFF_BYTES;
                if bytes.contains(&0) {
                    text =
                        format!("Binary file {path} is untracked; binary diff is not displayed.\n");
                } else {
                    let visible =
                        String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_GIT_DIFF_BYTES)]);
                    let line_count = visible.lines().count();
                    text = format!(
                        "diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{line_count} @@\n{}",
                        visible
                            .lines()
                            .map(|line| format!("+{line}\n"))
                            .collect::<String>()
                    );
                }
            }
        }
    }
    if truncated {
        text.push_str("\n…Diff 已达到 2 MB 安全上限，后续内容省略…\n");
    }
    Ok(text)
}

#[tauri::command]
pub async fn coding_git_set_staged(
    access: State<'_, FilesystemAccess>,
    root: String,
    path: String,
    staged: bool,
) -> Result<CodingGitSnapshot, String> {
    let root = access.require_workspace(&root)?;
    let path = normalize_git_relative_path(&root, &path)?;
    if git_output(&root, &["rev-parse", "--is-inside-work-tree"])
        .await
        .as_deref()
        != Some("true")
    {
        return Err("当前工作区不是 Git 仓库".into());
    }
    let arguments = if staged {
        vec!["add", "--", path.as_str()]
    } else {
        vec!["restore", "--staged", "--", path.as_str()]
    };
    let mut output = Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|error| format!("无法执行 Git 操作：{error}"))?;
    // `git restore --staged` requires a valid HEAD. Fresh repositories do not
    // have one yet, so fall back to removing only the index entry while keeping
    // the working-tree file intact.
    if !staged && !output.status.success() {
        output = Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["rm", "--cached", "--ignore-unmatch", "--", path.as_str()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .await
            .map_err(|error| format!("无法执行 Git 操作：{error}"))?;
    }
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "{}失败：{}",
            if staged {
                "暂存文件"
            } else {
                "取消暂存"
            },
            detail.trim().chars().take(1_000).collect::<String>()
        ));
    }
    Ok(git_snapshot(&root).await)
}

fn normalize_git_relative_path(root: &Path, claimed: &str) -> Result<String, String> {
    let raw = PathBuf::from(claimed);
    let relative = if raw.is_absolute() {
        raw.strip_prefix(root)
            .map_err(|_| "Git Diff 路径不在当前工作区内".to_string())?
            .to_path_buf()
    } else {
        raw
    };
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return Err("Git Diff 路径包含不安全的目录跳转".into());
    }
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

fn resolve_coding_document_path(root: &Path, claimed: &str) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(claimed);
    let candidate = if candidate.is_absolute() {
        candidate
    } else {
        root.join(candidate)
    };
    let metadata =
        std::fs::symlink_metadata(&candidate).map_err(|error| format!("无法读取文件：{error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("代码编辑器只能打开工作区内的普通文件".into());
    }
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("无法解析文件：{error}"))?;
    if !canonical.starts_with(root) {
        return Err("拒绝访问工作区之外的文件".into());
    }
    Ok(canonical)
}

fn document_hash(content: &[u8]) -> String {
    format!("{:x}", Sha256::digest(content))
}

fn editor_language(path: &Path) -> String {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "ts" => "typescript",
        "tsx" => "typescriptreact",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "javascriptreact",
        "rs" => "rust",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "py" => "python",
        "go" => "go",
        "c" | "h" => "c",
        "cc" | "cpp" | "cxx" | "hpp" => "cpp",
        "cs" => "csharp",
        "html" | "htm" => "html",
        "css" => "css",
        "scss" => "scss",
        "less" => "less",
        "json" => "json",
        "md" | "mdx" => "markdown",
        "xml" | "svg" => "xml",
        "yaml" | "yml" => "yaml",
        "toml" => "ini",
        "sh" | "bash" | "zsh" => "shell",
        "sql" => "sql",
        _ => "plaintext",
    }
    .to_string()
}

fn read_coding_document(root: &Path, claimed: &str) -> Result<CodingDocument, String> {
    let path = resolve_coding_document_path(root, claimed)?;
    let metadata =
        std::fs::metadata(&path).map_err(|error| format!("无法读取文件信息：{error}"))?;
    if metadata.len() as usize > MAX_DOCUMENT_BYTES {
        return Err("文件超过 4 MB，为避免编辑器卡顿已拒绝打开".into());
    }
    let bytes = std::fs::read(&path).map_err(|error| format!("读取文件失败：{error}"))?;
    if bytes.contains(&0) {
        return Err("二进制文件不能在代码编辑器中打开".into());
    }
    let content = String::from_utf8(bytes.clone())
        .map_err(|_| "文件不是 UTF-8 编码，暂不支持编辑".to_string())?;
    Ok(CodingDocument {
        path: path.to_string_lossy().into_owned(),
        relative_path: relative_display(root, &path),
        hash: document_hash(&bytes),
        size: bytes.len(),
        modified_at: metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_millis())
            .unwrap_or_default(),
        language: editor_language(&path),
        line_ending: if content.contains("\r\n") {
            "CRLF"
        } else {
            "LF"
        }
        .to_string(),
        content,
    })
}

#[tauri::command]
pub async fn coding_read_document(
    access: State<'_, FilesystemAccess>,
    root: String,
    path: String,
) -> Result<CodingDocument, String> {
    let root = access.require_workspace(&root)?;
    read_coding_document(&root, &path)
}

#[tauri::command]
pub async fn coding_write_document(
    access: State<'_, FilesystemAccess>,
    request: CodingWriteDocumentRequest,
) -> Result<CodingDocument, String> {
    if request.content.len() > MAX_DOCUMENT_BYTES {
        return Err("写入内容超过 4 MB 安全上限".into());
    }
    let root = access.require_workspace(&request.root)?;
    let path = resolve_coding_document_path(&root, &request.path)?;
    let current = std::fs::read(&path).map_err(|error| format!("保存前无法读取文件：{error}"))?;
    if document_hash(&current) != request.expected_hash {
        return Err("保存冲突：文件已被 Agent 或其他程序修改，请重新加载后合并改动".into());
    }
    let parent = path.parent().ok_or_else(|| "文件没有父目录".to_string())?;
    let name = path.file_name().ok_or_else(|| "文件名无效".to_string())?;
    let staging = parent.join(format!(
        ".{}.{}.{}.coding.tmp",
        name.to_string_lossy(),
        std::process::id(),
        uuid::Uuid::now_v7().simple()
    ));
    let result = (|| -> Result<(), String> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging)
            .map_err(|error| format!("创建临时文件失败：{error}"))?;
        file.write_all(request.content.as_bytes())
            .map_err(|error| format!("写入临时文件失败：{error}"))?;
        file.sync_all()
            .map_err(|error| format!("同步文件失败：{error}"))?;
        if let Ok(metadata) = std::fs::metadata(&path) {
            std::fs::set_permissions(&staging, metadata.permissions())
                .map_err(|error| format!("保留文件权限失败：{error}"))?;
        }
        drop(file);
        crate::paths::replace_file_atomically(&staging, &path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&staging);
    }
    result?;
    read_coding_document(&root, &path.to_string_lossy())
}

fn safe_new_entry_name(name: &str) -> Result<&str, String> {
    let value = name.trim();
    let path = Path::new(value);
    if value.is_empty()
        || value.len() > 240
        || value == "."
        || value == ".."
        || value.eq_ignore_ascii_case(".git")
        || value.contains('/')
        || value.contains('\\')
        || value
            .chars()
            .any(|character| character == '\0' || character.is_control())
        || path.components().count() != 1
        || !matches!(path.components().next(), Some(Component::Normal(_)))
    {
        return Err("名称不能为空、不能包含目录跳转或路径分隔符，也不能创建 .git".into());
    }
    Ok(value)
}

fn resolve_coding_directory_path(root: &Path, claimed: Option<&str>) -> Result<PathBuf, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("无法解析工作区：{error}"))?;
    let claimed = claimed.map(str::trim).filter(|value| !value.is_empty());
    let candidate = match claimed {
        Some(value) if Path::new(value).is_absolute() => PathBuf::from(value),
        Some(value) => canonical_root.join(value),
        None => canonical_root.clone(),
    };
    let metadata = std::fs::symlink_metadata(&candidate)
        .map_err(|error| format!("无法读取父目录：{error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("只能在工作区内的真实目录中创建文件".into());
    }
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("无法解析父目录：{error}"))?;
    if !canonical.starts_with(&canonical_root) {
        return Err("拒绝在工作区之外创建文件".into());
    }
    Ok(canonical)
}

#[tauri::command]
pub async fn coding_create_entry(
    access: State<'_, FilesystemAccess>,
    request: CodingCreateEntryRequest,
) -> Result<String, String> {
    let root = access.require_workspace(&request.root)?;
    let parent = resolve_coding_directory_path(&root, request.parent.as_deref())?;
    let name = safe_new_entry_name(&request.name)?;
    let target = parent.join(name);
    if target.exists() {
        return Err("同名文件或目录已经存在".into());
    }
    if request.directory {
        std::fs::create_dir(&target).map_err(|error| format!("创建目录失败：{error}"))?;
    } else {
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|error| format!("创建文件失败：{error}"))?;
    }
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn coding_terminal_create(
    app: AppHandle,
    access: State<'_, FilesystemAccess>,
    processes: State<'_, CodingProcesses>,
    root: String,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<CodingTerminalCreated, String> {
    let root = access.require_workspace(&root)?;
    #[cfg(target_os = "windows")]
    let shell = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
    #[cfg(not(target_os = "windows"))]
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|value| Path::new(value).is_absolute() && Path::new(value).is_file())
        .unwrap_or_else(|| "/bin/sh".to_string());
    let config = PtyConfig {
        command: vec![shell],
        cols: cols.unwrap_or(100).clamp(20, 500),
        rows: rows.unwrap_or(28).clamp(5, 200),
        cwd: Some(root),
        env: HashMap::new(),
    };
    let handle = tokio::task::spawn_blocking(move || PtyHandle::spawn(&config))
        .await
        .map_err(|error| format!("终端启动任务失败：{error}"))?
        .map_err(|error| format!("无法创建交互式终端：{error}"))?;
    let (master, child, mut reader, writer) = handle.into_parts();
    let terminal_id = uuid::Uuid::now_v7().to_string();
    let session = Arc::new(CodingTerminalSession {
        master,
        child: Mutex::new(child),
        writer: Mutex::new(writer),
    });
    {
        let mut terminals = processes
            .terminals
            .lock()
            .map_err(|_| "终端状态已损坏".to_string())?;
        terminals.retain(|_, session| session.child.lock().is_ok_and(|mut child| child.is_alive()));
        if terminals.len() >= 8 {
            if let Ok(mut child) = session.child.lock() {
                let _ = child.kill();
            }
            return Err("代码工作台最多同时保留 8 个终端".into());
        }
        terminals.insert(terminal_id.clone(), session);
    }
    let event_terminal_id = terminal_id.clone();
    let output_thread = std::thread::Builder::new()
        .name(format!("coding-pty-{}", &terminal_id[..8]))
        .spawn(move || {
            let mut buffer = [0u8; 8 * 1024];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        let _ = app.emit(
                            "coding://terminal-output",
                            CodingTerminalEvent {
                                terminal_id: event_terminal_id.clone(),
                                data_base64: base64::engine::general_purpose::STANDARD
                                    .encode(&buffer[..count]),
                            },
                        );
                    }
                }
            }
            let _ = app.emit(
                "coding://terminal-exit",
                CodingTerminalEvent {
                    terminal_id: event_terminal_id,
                    data_base64: String::new(),
                },
            );
        });
    if let Err(error) = output_thread {
        if let Ok(mut terminals) = processes.terminals.lock() {
            if let Some(session) = terminals.remove(&terminal_id) {
                if let Ok(mut child) = session.child.lock() {
                    let _ = terminate_terminal_child(&mut child);
                }
            }
        }
        return Err(format!("无法启动终端输出线程：{error}"));
    }
    Ok(CodingTerminalCreated { terminal_id })
}

#[tauri::command]
pub async fn coding_terminal_write(
    processes: State<'_, CodingProcesses>,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    if data.len() > 64 * 1024 || data.contains('\0') {
        return Err("终端输入超过 64 KB 或包含空字符".into());
    }
    let session = processes
        .terminals
        .lock()
        .map_err(|_| "终端状态已损坏".to_string())?
        .get(&terminal_id)
        .cloned()
        .ok_or_else(|| "终端不存在或已经关闭".to_string())?;
    tokio::task::spawn_blocking(move || {
        let mut writer = session
            .writer
            .lock()
            .map_err(|_| "终端输入状态已损坏".to_string())?;
        writer
            .write_all(data.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|error| format!("写入终端失败：{error}"))
    })
    .await
    .map_err(|error| format!("终端输入任务失败：{error}"))?
}

#[tauri::command]
pub async fn coding_terminal_resize(
    processes: State<'_, CodingProcesses>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = processes
        .terminals
        .lock()
        .map_err(|_| "终端状态已损坏".to_string())?
        .get(&terminal_id)
        .cloned()
        .ok_or_else(|| "终端不存在或已经关闭".to_string())?;
    session
        .master
        .resize(cols.clamp(20, 500), rows.clamp(5, 200))
        .map_err(|error| format!("调整终端尺寸失败：{error}"))
}

#[tauri::command]
pub async fn coding_terminal_close(
    processes: State<'_, CodingProcesses>,
    terminal_id: String,
) -> Result<bool, String> {
    let session = processes
        .terminals
        .lock()
        .map_err(|_| "终端状态已损坏".to_string())?
        .remove(&terminal_id);
    let Some(session) = session else {
        return Ok(false);
    };
    tokio::task::spawn_blocking(move || {
        let mut child = session
            .child
            .lock()
            .map_err(|_| "终端进程状态已损坏".to_string())?;
        terminate_terminal_child(&mut child)
    })
    .await
    .map_err(|error| format!("关闭终端任务失败：{error}"))??;
    Ok(true)
}

fn fallback_code_search(root: &Path, query: &str) -> Vec<CodingSearchHit> {
    let case_sensitive = query.chars().any(char::is_uppercase);
    let needle = if case_sensitive {
        query.to_string()
    } else {
        query.to_lowercase()
    };
    let mut hits = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut scanned = 0usize;
    while let Some((directory, depth)) = stack.pop() {
        if scanned >= MAX_SCANNED_FILES || hits.len() >= MAX_SEARCH_RESULTS {
            break;
        }
        let Ok(entries) = std::fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            if scanned >= MAX_SCANNED_FILES || hits.len() >= MAX_SEARCH_RESULTS {
                break;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if file_type.is_dir() {
                if depth < MAX_SCAN_DEPTH
                    && !IGNORED_DIRECTORIES.contains(&name.as_str())
                    && !(name.starts_with('.')
                        && !matches!(name.as_str(), ".github" | ".echoagent"))
                {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            scanned += 1;
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if metadata.len() > 1024 * 1024 {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&path) else {
                continue;
            };
            for (line_index, line) in content.lines().enumerate() {
                let haystack = if case_sensitive {
                    line.to_string()
                } else {
                    line.to_lowercase()
                };
                if let Some(column) = haystack.find(&needle) {
                    hits.push(CodingSearchHit {
                        path: relative_display(root, &path),
                        line: line_index + 1,
                        column: haystack[..column].chars().count() + 1,
                        preview: bounded_search_preview(line),
                    });
                    if hits.len() >= MAX_SEARCH_RESULTS {
                        break;
                    }
                }
            }
        }
    }
    hits.sort_by(|left, right| left.path.cmp(&right.path).then(left.line.cmp(&right.line)));
    hits
}

fn bounded_search_preview(line: &str) -> String {
    let trimmed = line.trim_end();
    let mut preview = trimmed
        .chars()
        .take(MAX_SEARCH_PREVIEW_CHARS)
        .collect::<String>();
    if trimmed.chars().count() > MAX_SEARCH_PREVIEW_CHARS {
        preview.push('…');
    }
    preview
}

#[tauri::command]
pub async fn coding_search_workspace(
    access: State<'_, FilesystemAccess>,
    root: String,
    query: String,
) -> Result<Vec<CodingSearchHit>, String> {
    let root = access.require_workspace(&root)?;
    let query = query.trim();
    if query.is_empty() || query.chars().count() > 256 || query.contains('\0') {
        return Err("搜索词不能为空且不能超过 256 个字符".into());
    }
    let mut command = Command::new("rg");
    command
        .args([
            "--line-number",
            "--column",
            "--no-heading",
            "--no-messages",
            "--color",
            "never",
            "--smart-case",
            "--fixed-strings",
            "--max-count",
            "100",
            "--max-filesize",
            "4M",
            "--glob",
            "!.git/**",
            "--glob",
            "!node_modules/**",
            "--glob",
            "!target/**",
            "--glob",
            "!dist/**",
            "--glob",
            "!build/**",
            "--",
            query,
            ".",
        ])
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(fallback_code_search(&root, query));
        }
        Err(error) => return Err(format!("无法启动代码搜索：{error}")),
    };
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取代码搜索结果".to_string())?;
    let mut lines = BufReader::new(stdout).lines();
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法读取代码搜索错误".to_string())?;
    let stderr_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stderr
            .take(64 * 1024)
            .read_to_end(&mut bytes)
            .await
            .map(|_| bytes)
    });
    let mut hits = Vec::new();
    while let Some(line) = lines
        .next_line()
        .await
        .map_err(|error| format!("读取代码搜索结果失败：{error}"))?
    {
        let mut columns = line.splitn(4, ':');
        let Some(path) = columns.next() else { continue };
        let Some(line_number) = columns.next().and_then(|value| value.parse::<usize>().ok()) else {
            continue;
        };
        let Some(byte_column) = columns.next().and_then(|value| value.parse::<usize>().ok()) else {
            continue;
        };
        let raw_preview = columns.next().unwrap_or_default();
        let column = raw_preview
            .char_indices()
            .take_while(|(offset, _)| *offset < byte_column.saturating_sub(1))
            .count()
            + 1;
        let preview = bounded_search_preview(raw_preview);
        hits.push(CodingSearchHit {
            path: path.trim_start_matches("./").replace('\\', "/"),
            line: line_number,
            column,
            preview,
        });
        if hits.len() >= MAX_SEARCH_RESULTS {
            break;
        }
    }
    let capped = hits.len() >= MAX_SEARCH_RESULTS;
    let status = if capped {
        let _ = child.kill().await;
        child.wait().await.ok()
    } else {
        Some(
            child
                .wait()
                .await
                .map_err(|error| format!("等待代码搜索完成失败：{error}"))?,
        )
    };
    let stderr = stderr_task
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();
    if !capped && !status.is_some_and(|status| status.success() || status.code() == Some(1)) {
        return Err(format!(
            "代码搜索失败：{}",
            String::from_utf8_lossy(&stderr).trim()
        ));
    }
    Ok(hits)
}

#[tauri::command]
pub async fn coding_analyze_workspace(
    access: State<'_, FilesystemAccess>,
    root: String,
) -> Result<CodingWorkspaceAnalysis, String> {
    let root = access.require_workspace(&root)?;
    let mut stack = vec![(root.clone(), 0usize)];
    let mut file_count = 0usize;
    let mut truncated = false;
    let mut language_counts = BTreeMap::<String, usize>::new();
    let mut manifests = Vec::<ManifestCandidate>::new();
    let mut instruction_files = Vec::<String>::new();

    while let Some((directory, depth)) = stack.pop() {
        if file_count >= MAX_SCANNED_FILES {
            truncated = true;
            break;
        }
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            if file_count >= MAX_SCANNED_FILES {
                truncated = true;
                break;
            }
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if file_type.is_dir() {
                if depth < MAX_SCAN_DEPTH
                    && !IGNORED_DIRECTORIES.contains(&name.as_str())
                    && !(name.starts_with('.')
                        && !matches!(name.as_str(), ".github" | ".echoagent"))
                {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            file_count += 1;
            if matches!(
                name.to_ascii_lowercase().as_str(),
                "agents.md" | "claude.md" | "copilot-instructions.md" | ".cursorrules"
            ) || relative_display(&root, &path).starts_with(".echoagent/rules/")
            {
                instruction_files.push(relative_display(&root, &path));
            }
            if let Some(kind) = manifest_kind(&name) {
                manifests.push(ManifestCandidate {
                    path: path.clone(),
                    kind,
                });
            }
            if let Some(language) = path
                .extension()
                .and_then(|value| value.to_str())
                .and_then(language_for_extension)
            {
                *language_counts.entry(language.to_string()).or_default() += 1;
            }
        }
    }
    manifests.sort_by(|left, right| left.path.cmp(&right.path));

    let mut seen_module_roots = HashSet::new();
    let mut modules = Vec::<CodingModule>::new();
    for manifest in &manifests {
        let Some(module_root) = manifest.path.parent() else {
            continue;
        };
        let key = module_root.to_path_buf();
        if !seen_module_roots.insert(key) {
            continue;
        }
        modules.push(CodingModule {
            name: module_name(manifest, module_root),
            path: relative_display(&root, module_root),
            kind: manifest.kind.to_string(),
            dependencies: Vec::new(),
        });
    }
    if modules.is_empty() {
        modules.push(CodingModule {
            name: root
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("workspace")
                .to_string(),
            path: ".".into(),
            kind: "Generic".into(),
            dependencies: Vec::new(),
        });
    }

    // A bounded, deterministic local dependency graph. Manifest references to
    // another discovered module are enough to produce a trustworthy edge;
    // ambiguous source-level guesses are deliberately omitted.
    let module_names = modules
        .iter()
        .map(|module| module.name.clone())
        .collect::<Vec<_>>();
    for module in &mut modules {
        let module_root = root.join(&module.path);
        let manifest_text = manifests
            .iter()
            .filter(|candidate| candidate.path.parent() == Some(module_root.as_path()))
            .filter_map(|candidate| bounded_text(&candidate.path))
            .collect::<Vec<_>>()
            .join("\n");
        module.dependencies = module_names
            .iter()
            .filter(|candidate| {
                candidate.as_str() != module.name.as_str()
                    && manifest_text.contains(candidate.as_str())
            })
            .cloned()
            .collect();
        module.dependencies.sort();
        module.dependencies.dedup();
    }
    modules.sort_by(|left, right| left.path.cmp(&right.path));

    let mut languages = language_counts
        .into_iter()
        .map(|(language, files)| CodingLanguageStat { language, files })
        .collect::<Vec<_>>();
    languages.sort_by(|left, right| {
        right
            .files
            .cmp(&left.files)
            .then_with(|| left.language.cmp(&right.language))
    });

    let git_top = git_output(&root, &["rev-parse", "--show-toplevel"]).await;
    let has_git = git_top.is_some();
    let git_branch = if has_git {
        git_output(&root, &["branch", "--show-current"])
            .await
            .filter(|value| !value.is_empty())
    } else {
        None
    };
    let git_changed_files = if has_git {
        git_output(
            &root,
            &["status", "--porcelain=v1", "--untracked-files=normal"],
        )
        .await
        .map(|value| value.lines().filter(|line| !line.trim().is_empty()).count())
        .unwrap_or_default()
    } else {
        0
    };
    let mut project_kinds = manifests
        .iter()
        .map(|manifest| manifest.kind)
        .collect::<Vec<_>>();
    project_kinds.sort();
    project_kinds.dedup();
    let project_type = project_kinds.join(" + ");
    let commands = validation_commands(&root, &manifests);
    instruction_files.sort();
    instruction_files.dedup();
    instruction_files.truncate(64);

    Ok(CodingWorkspaceAnalysis {
        root: root.to_string_lossy().into_owned(),
        name: root
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("workspace")
            .to_string(),
        project_type,
        file_count,
        truncated,
        languages,
        modules,
        validation_commands: commands,
        has_git,
        git_branch,
        git_changed_files,
        instruction_files,
        scanned_at: chrono::Utc::now().to_rfc3339(),
    })
}

fn strip_ansi(value: String) -> String {
    let expression = regex::Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").expect("valid ANSI regex");
    expression.replace_all(&value, "").into_owned()
}

async fn collect_bounded_output<R>(
    app: Option<AppHandle>,
    run_id: String,
    stream: &'static str,
    mut reader: R,
) -> std::io::Result<(String, bool)>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    let mut retained = Vec::with_capacity(MAX_COMMAND_OUTPUT_BYTES.min(64 * 1024));
    let mut truncated = false;
    let mut chunk = [0u8; 8 * 1024];
    loop {
        let count = reader.read(&mut chunk).await?;
        if count == 0 {
            break;
        }
        let visible = strip_ansi(String::from_utf8_lossy(&chunk[..count]).into_owned());
        if let Some(app) = app.as_ref() {
            let _ = app.emit(
                "coding://command-output",
                CodingCommandOutputEvent {
                    run_id: run_id.clone(),
                    stream: stream.to_string(),
                    data: visible,
                },
            );
        }
        let remaining = MAX_COMMAND_OUTPUT_BYTES.saturating_sub(retained.len());
        if remaining > 0 {
            retained.extend_from_slice(&chunk[..count.min(remaining)]);
        }
        if count > remaining {
            truncated = true;
        }
    }
    let mut output = strip_ansi(String::from_utf8_lossy(&retained).into_owned());
    if truncated {
        output.push_str("\n…输出已达到安全上限，后续内容省略…");
    }
    Ok((output, truncated))
}

async fn finish_output_capture(
    mut handle: JoinHandle<std::io::Result<(String, bool)>>,
) -> (String, bool) {
    match tokio::time::timeout(std::time::Duration::from_secs(2), &mut handle).await {
        Ok(Ok(Ok(capture))) => capture,
        Ok(Ok(Err(error))) => (format!("无法读取命令输出：{error}"), true),
        Ok(Err(error)) => (format!("命令输出任务失败：{error}"), true),
        Err(_) => {
            handle.abort();
            ("命令输出管道未及时关闭，已停止采集".into(), true)
        }
    }
}

fn dangerous_delete_target(raw: &str, workspace_root: &Path) -> bool {
    let unquoted = raw
        .trim_matches(|character| character == '\'' || character == '"')
        .trim_end_matches(['/', '\\']);
    let value = unquoted.to_ascii_lowercase();
    value.is_empty()
        || matches!(
            value.as_str(),
            "/" | "."
                | "./"
                | ".."
                | "~"
                | "$home"
                | "${home}"
                | "$pwd"
                | "${pwd}"
                | "$(pwd)"
                | "`pwd`"
                | "%cd%"
        )
        || value.contains('*')
        || value == ".git"
        || value.starts_with(".git/")
        || value.ends_with("/.git")
        || value.contains("/.git/")
        || matches!(
            value.as_str(),
            "/usr"
                | "/var"
                | "/etc"
                | "/bin"
                | "/sbin"
                | "/lib"
                | "/opt"
                | "/boot"
                | "/root"
                | "/home"
                | "/system"
                | "/library"
                | "/tmp"
                | "/dev"
        )
        || {
            let canonical_workspace = workspace_root
                .canonicalize()
                .unwrap_or_else(|_| workspace_root.to_path_buf());
            let candidate = Path::new(unquoted);
            let candidate = if candidate.is_absolute() {
                candidate.to_path_buf()
            } else {
                canonical_workspace.join(candidate)
            };
            candidate
                .canonicalize()
                .ok()
                .is_some_and(|target| canonical_workspace.starts_with(target))
        }
}

/// Defense in depth for the renderer-facing command endpoint. The UI already
/// presents risk confirmation, but a forged IPC call must still be unable to
/// execute commands that discard repositories or damage system paths.
/// Public so the verification engine reuses this single high-risk policy rather
/// than maintaining a second copy of the rules.
pub fn high_risk_command_reason(command: &str, workspace_root: &Path) -> Option<&'static str> {
    let normalized = command.to_ascii_lowercase();
    let patterns = [
        (r"\bdd\s+[^\r\n]*\bof=/dev/", "禁止 dd 写入块设备"),
        (r"(?:^|[;&|]\s*)mkfs(?:\.|\s)", "禁止格式化文件系统"),
        (r"\bchmod\s+777\s+/", "禁止修改系统根目录权限"),
        (r"\bgit\s+reset\s+--hard\b", "禁止丢弃 Git 工作区改动"),
        (
            r"\bgit\s+clean\s+[^\r\n]*-[fdx]+",
            "禁止强制清理 Git 未跟踪文件",
        ),
        (r"\bgit\s+push\s+[^\r\n]*--force\b", "禁止强制覆盖远端分支"),
        (
            r"\bgit\s+checkout\s+(?:-f|--force)\b",
            "禁止强制签出并丢弃改动",
        ),
        (r"\bgit\s+checkout\s+--\s+\.", "禁止批量还原全部改动"),
        (
            r"\bfind\s+[^\r\n]*(?:-exec|-delete)\b",
            "禁止 find 批量执行或删除",
        ),
    ];
    for (pattern, reason) in patterns {
        if regex::Regex::new(pattern)
            .expect("valid command policy regex")
            .is_match(&normalized)
        {
            return Some(reason);
        }
    }

    for segment in normalized.split([';', '|', '&']) {
        let tokens = segment.split_whitespace().collect::<Vec<_>>();
        let Some(rm_index) = tokens
            .iter()
            .position(|token| matches!(*token, "rm" | "\\rm") || token.ends_with("/rm"))
        else {
            continue;
        };
        let arguments = &tokens[rm_index + 1..];
        let recursive = arguments.iter().any(|token| {
            matches!(*token, "--recursive")
                || (token.starts_with('-')
                    && token[1..].chars().any(|flag| matches!(flag, 'r' | 'R')))
        });
        let force = arguments.iter().any(|token| {
            matches!(*token, "--force") || (token.starts_with('-') && token[1..].contains('f'))
        });
        if recursive
            && force
            && arguments
                .iter()
                .filter(|token| !token.starts_with('-'))
                .any(|token| dangerous_delete_target(token, workspace_root))
        {
            return Some("禁止递归强制删除危险路径");
        }
    }
    None
}

async fn terminate_command_tree(process: &mut tokio::process::Child) {
    let pid = process.id();
    #[cfg(unix)]
    if let Some(pid) = pid {
        // The command is spawned in its own process group below. Terminating
        // the group also stops grandchildren such as pnpm/node test workers.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
        tokio::time::sleep(std::time::Duration::from_millis(180)).await;
        if process.try_wait().ok().flatten().is_none() {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
    }
    #[cfg(target_os = "windows")]
    if let Some(pid) = pid {
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status(),
        )
        .await;
    }
    let _ = process.kill().await;
    let _ = process.wait().await;
}

#[tauri::command]
pub async fn coding_run_command(
    app: AppHandle,
    access: State<'_, FilesystemAccess>,
    processes: State<'_, CodingProcesses>,
    request: CodingRunCommandRequest,
) -> Result<CodingCommandResult, String> {
    let root = access.require_workspace(&request.root)?;
    let command_text = request.command.trim();
    if command_text.is_empty() {
        return Err("命令不能为空".into());
    }
    if command_text.chars().count() > MAX_COMMAND_CHARS
        || command_text.contains('\0')
        || command_text
            .chars()
            .any(|character| character == '\r' || character == '\n')
    {
        return Err("命令过长或包含不支持的控制字符".into());
    }
    if let Some(reason) = high_risk_command_reason(command_text, &root) {
        return Err(format!("命令被原生安全策略拒绝：{reason}"));
    }
    let timeout_secs = request.timeout_secs.unwrap_or(180).clamp(5, 300);
    let run_id = request
        .run_id
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 100
                && value.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
                })
        })
        .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
    let cancellation = CancellationToken::new();
    let started = Instant::now();

    #[cfg(target_os = "windows")]
    let mut child = {
        let mut command = Command::new("cmd");
        command.args(["/D", "/S", "/C", command_text]);
        command
    };
    #[cfg(not(target_os = "windows"))]
    let mut child = {
        let mut command = Command::new("sh");
        command.args(["-lc", command_text]);
        command
    };
    child
        .current_dir(&root)
        .env("CI", "true")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    child.process_group(0);

    let mut process = child
        .spawn()
        .map_err(|error| format!("无法执行命令：{error}"))?;
    let stdout = process
        .stdout
        .take()
        .ok_or_else(|| "无法捕获命令标准输出".to_string())?;
    let stderr = process
        .stderr
        .take()
        .ok_or_else(|| "无法捕获命令错误输出".to_string())?;
    {
        let mut commands = processes
            .commands
            .lock()
            .map_err(|_| "命令运行状态已损坏".to_string())?;
        if commands.contains_key(&run_id) {
            return Err("命令运行标识已存在".into());
        }
        commands.insert(run_id.clone(), cancellation.clone());
    }
    let stdout_task = tokio::spawn(collect_bounded_output(
        Some(app.clone()),
        run_id.clone(),
        "stdout",
        stdout,
    ));
    let stderr_task = tokio::spawn(collect_bounded_output(
        Some(app),
        run_id.clone(),
        "stderr",
        stderr,
    ));
    enum ProcessOutcome {
        Exited(std::io::Result<std::process::ExitStatus>),
        TimedOut,
        Cancelled,
    }
    let outcome = tokio::select! {
        status = process.wait() => ProcessOutcome::Exited(status),
        _ = tokio::time::sleep(std::time::Duration::from_secs(timeout_secs)) => ProcessOutcome::TimedOut,
        _ = cancellation.cancelled() => ProcessOutcome::Cancelled,
    };
    let duration_ms = started.elapsed().as_millis();
    let (exit_code, timed_out, cancelled, termination_notice) = match outcome {
        ProcessOutcome::TimedOut => {
            terminate_command_tree(&mut process).await;
            (
                None,
                true,
                false,
                Some(format!("命令运行超过 {timeout_secs} 秒，已终止")),
            )
        }
        ProcessOutcome::Cancelled => {
            terminate_command_tree(&mut process).await;
            (None, false, true, Some("命令已由用户停止".to_string()))
        }
        ProcessOutcome::Exited(Err(error)) => {
            terminate_command_tree(&mut process).await;
            if let Ok(mut commands) = processes.commands.lock() {
                commands.remove(&run_id);
            }
            return Err(format!("无法等待命令结果：{error}"));
        }
        ProcessOutcome::Exited(Ok(status)) => (status.code(), false, false, None),
    };
    let (stdout, stdout_truncated) = finish_output_capture(stdout_task).await;
    let (mut stderr, stderr_truncated) = finish_output_capture(stderr_task).await;
    if let Some(notice) = termination_notice {
        if !stderr.is_empty() {
            stderr.push('\n');
        }
        stderr.push_str(&notice);
    }
    processes
        .commands
        .lock()
        .map_err(|_| "命令运行状态已损坏".to_string())?
        .remove(&run_id);
    Ok(CodingCommandResult {
        run_id,
        command: command_text.to_string(),
        stdout,
        stderr,
        exit_code,
        duration_ms,
        timed_out,
        cancelled,
        truncated: stdout_truncated || stderr_truncated,
    })
}

#[tauri::command]
pub async fn coding_cancel_command(
    processes: State<'_, CodingProcesses>,
    run_id: String,
) -> Result<bool, String> {
    let token = processes
        .commands
        .lock()
        .map_err(|_| "命令运行状态已损坏".to_string())?
        .get(&run_id)
        .cloned();
    if let Some(token) = token {
        token.cancel();
        Ok(true)
    } else {
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_common_languages_and_manifests() {
        assert_eq!(language_for_extension("tsx"), Some("TypeScript"));
        assert_eq!(language_for_extension("java"), Some("Java"));
        assert_eq!(manifest_kind("pom.xml"), Some("Maven"));
        assert_eq!(manifest_kind("package.json"), Some("Node.js"));
    }

    #[test]
    fn extracts_minimal_manifest_names() {
        assert_eq!(
            first_tag(
                "<project><artifactId>orders</artifactId></project>",
                "artifactId"
            )
            .as_deref(),
            Some("orders")
        );
        assert_eq!(
            quoted_toml_value("name = \"workspace\"", "name").as_deref(),
            Some("workspace")
        );
    }

    #[test]
    fn validation_commands_cover_polyglot_roots() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("pom.xml"), "<project />").unwrap();
        std::fs::write(
            temp.path().join("package.json"),
            r#"{"scripts":{"test":"vitest","build":"vite build"}}"#,
        )
        .unwrap();
        let manifests = vec![
            ManifestCandidate {
                path: temp.path().join("pom.xml"),
                kind: "Maven",
            },
            ManifestCandidate {
                path: temp.path().join("package.json"),
                kind: "Node.js",
            },
        ];
        let commands = validation_commands(temp.path(), &manifests);
        assert!(commands.contains(&"mvn test".to_string()));
        assert!(commands.contains(&"npm test".to_string()));
        assert!(commands.contains(&"npm run build".to_string()));
    }

    #[test]
    fn validation_commands_respect_nested_modules_and_declared_node_scripts() {
        let temp = tempfile::tempdir().unwrap();
        let package = temp.path().join("web");
        std::fs::create_dir(&package).unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"scripts":{"test":"vitest"}}"#,
        )
        .unwrap();
        let manifests = vec![ManifestCandidate {
            path: package.join("package.json"),
            kind: "Node.js",
        }];
        let commands = validation_commands(temp.path(), &manifests);
        assert_eq!(commands, vec!["npm --prefix \"web\" test"]);
    }

    #[test]
    fn native_policy_rejects_destructive_commands_even_inside_shell_chains() {
        let workspace = tempfile::tempdir().unwrap();
        let root = workspace.path();
        let parent = root.parent().unwrap().to_string_lossy();
        assert!(high_risk_command_reason("rm -rf /", root).is_some());
        assert!(high_risk_command_reason("rm -rf .", root).is_some());
        assert!(high_risk_command_reason("rm -rf ./", root).is_some());
        assert!(high_risk_command_reason("rm -rf \"$PWD\"", root).is_some());
        assert!(high_risk_command_reason(&format!("rm -rf \"{parent}\""), root).is_some());
        assert!(high_risk_command_reason("cd src && rm -rf ..", root).is_some());
        assert!(high_risk_command_reason("echo done && rm -rf .git", root).is_some());
        assert!(high_risk_command_reason("git reset --hard HEAD~1", root).is_some());
        assert!(high_risk_command_reason("find . -name '*.tmp' -delete", root).is_some());
        assert!(high_risk_command_reason("rm -rf build", root).is_none());
        assert!(high_risk_command_reason("mvn test", root).is_none());
    }

    #[test]
    fn parses_nul_delimited_git_status_without_guessing_from_chat_messages() {
        let stats = HashMap::from([
            ("src/app.ts".to_string(), (4usize, 1usize)),
            ("src/new.ts".to_string(), (7usize, 0usize)),
        ]);
        let files = parse_git_status(
            b" M src/app.ts\0?? src/new.ts\0R  src/renamed.ts\0src/old.ts\0",
            &stats,
        );
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].path, "src/app.ts");
        assert_eq!((files[0].added, files[0].removed), (4, 1));
        assert_eq!(files[1].status, "untracked");
        assert_eq!(files[2].old_path.as_deref(), Some("src/old.ts"));
    }

    #[test]
    fn git_diff_paths_allow_deleted_files_but_reject_workspace_escape() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(
            normalize_git_relative_path(temp.path(), "src/deleted.ts").unwrap(),
            "src/deleted.ts"
        );
        assert!(normalize_git_relative_path(temp.path(), "../secret").is_err());
        assert!(normalize_git_relative_path(temp.path(), "/tmp/outside").is_err());
    }

    #[test]
    fn new_entries_are_single_safe_names() {
        assert_eq!(safe_new_entry_name("feature.ts").unwrap(), "feature.ts");
        assert!(safe_new_entry_name("../outside").is_err());
        assert!(safe_new_entry_name("nested/file.ts").is_err());
        assert!(safe_new_entry_name("nested\\file.ts").is_err());
        assert!(safe_new_entry_name(".git").is_err());
        assert!(safe_new_entry_name("").is_err());
    }

    #[test]
    fn new_entries_stay_inside_real_workspace_directories() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let nested = workspace.path().join("src");
        std::fs::create_dir(&nested).unwrap();
        assert_eq!(
            resolve_coding_directory_path(workspace.path(), Some("src")).unwrap(),
            nested.canonicalize().unwrap()
        );
        assert!(resolve_coding_directory_path(workspace.path(), outside.path().to_str()).is_err());
        assert!(resolve_coding_directory_path(workspace.path(), Some("missing")).is_err());
    }

    #[tokio::test]
    async fn git_stage_helper_uses_one_safe_workspace_relative_path() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let init = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["init", "-q"])
            .output()
            .await
            .unwrap();
        assert!(init.status.success());
        std::fs::write(root.join("safe.txt"), "safe\n").unwrap();
        let path = normalize_git_relative_path(root, "safe.txt").unwrap();
        let staged = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["add", "--", path.as_str()])
            .output()
            .await
            .unwrap();
        assert!(staged.status.success());
        assert!(normalize_git_relative_path(root, "../../outside").is_err());
    }

    #[test]
    fn fallback_search_is_bounded_and_returns_real_locations() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("src")).unwrap();
        std::fs::write(
            temp.path().join("src/app.ts"),
            "export const cancelOrder = true;\n",
        )
        .unwrap();
        let hits = fallback_code_search(temp.path(), "cancelOrder");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "src/app.ts");
        assert_eq!((hits[0].line, hits[0].column), (1, 14));
    }

    #[cfg(unix)]
    #[test]
    fn interactive_pty_starts_inside_the_selected_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let config = PtyConfig {
            command: vec![
                "/bin/sh".to_string(),
                "-lc".to_string(),
                "printf '%s' \"$PWD\"".to_string(),
            ],
            cols: 80,
            rows: 24,
            cwd: Some(temp.path().to_path_buf()),
            env: HashMap::new(),
        };
        let handle = PtyHandle::spawn(&config).expect("PTY should start");
        let (master, mut child, mut reader, writer) = handle.into_parts();
        let read_thread = std::thread::spawn(move || {
            let mut bytes = vec![0u8; 4 * 1024];
            let count = reader
                .read(&mut bytes)
                .expect("PTY output should be readable");
            bytes.truncate(count);
            String::from_utf8_lossy(&bytes).into_owned()
        });
        assert_eq!(child.wait().expect("PTY child should finish"), 0);
        drop(writer);
        drop(master);
        let output = read_thread.join().expect("PTY reader should finish");
        assert!(output.contains(temp.path().to_string_lossy().as_ref()));
    }

    #[tokio::test]
    async fn command_output_is_drained_but_retained_memory_is_capped() {
        use tokio::io::AsyncWriteExt;

        let (mut writer, reader) = tokio::io::duplex(32 * 1024);
        let write_task = tokio::spawn(async move {
            writer
                .write_all(&vec![b'x'; MAX_COMMAND_OUTPUT_BYTES + 8 * 1024])
                .await
                .unwrap();
        });
        let (output, truncated) = collect_bounded_output(None, "test".into(), "stdout", reader)
            .await
            .unwrap();
        write_task.await.unwrap();

        assert!(truncated);
        assert!(output.starts_with("xxx"));
        assert!(output.len() < MAX_COMMAND_OUTPUT_BYTES + 100);
        assert!(output.ends_with("后续内容省略…"));
    }
}
