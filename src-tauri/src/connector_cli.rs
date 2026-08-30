//! CLI-type connector authorization engine (企业微信 / 飞书 / 钉钉 …).
//!
//! Mirrors echo-agent's `ConnectorService.connectCli`: each CLI connector ships
//! a `cli.json` describing how to install (`init`), version-check, authorize
//! (`auth` — one or more steps whose stdout contains an auth URL), and verify
//! (`status` + `statusMatch`/`statusMatchJson`). We run those commands as
//! child processes, stream the auth URL to the frontend as events (the UI
//! shows a QR modal or opens the browser), and re-check status at the end.
//!
//! Events emitted (listened by the connectors panel):
//! - `connector://cli-auth-url`  `{ source, url, qrModal, suppressBrowser }`
//! - `connector://cli-auth-log`  `{ source, line }`
//! - `connector://cli-auth-done` `{ source, ok, authed, error? }`

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Default per-step wait when `authWaitForExit` is absent: if the step has a
/// URL domain we wait (user must complete the web flow); otherwise a plain
/// command just runs to completion anyway.
const STEP_TIMEOUT: Duration = Duration::from_secs(600);
const SHORT_TIMEOUT: Duration = Duration::from_secs(30);

// ---------- cli.json schema ----------

/// Per-platform command map: `{ "win32": "...", "darwin": "...", "linux": "..." }`.
type PlatformCmd = HashMap<String, String>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliSpec {
    #[serde(default)]
    init: Option<PlatformCmd>,
    #[serde(default)]
    version_check: Option<VersionCheck>,
    #[serde(default)]
    auth: Option<AuthSpec>,
    #[serde(default)]
    un_auth: Option<PlatformCmd>,
    #[serde(default)]
    status: Option<PlatformCmd>,
    #[serde(default)]
    status_match: Option<String>,
    #[serde(default)]
    status_match_json: Option<HashMap<String, String>>,
    /// Top-level fallbacks used when `auth` is a bare PlatformCmd (wecom /
    /// dingtalk style, as opposed to feishu's array-of-steps style).
    #[serde(default)]
    auth_url_domain: Option<String>,
    #[serde(default)]
    auth_wait_for_exit: Option<bool>,
    #[serde(default)]
    auth_qr_modal: Option<bool>,
    #[serde(default)]
    auth_suppress_browser: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionCheck {
    command: PlatformCmd,
    #[serde(default)]
    min_version: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum AuthSpec {
    /// feishu style: ordered steps, each with its own command/skipIf/domain.
    Steps(Vec<AuthStep>),
    /// wecom / dingtalk style: a single per-platform command; step options
    /// come from the spec's top-level `auth*` fields.
    Single(PlatformCmd),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthStep {
    command: PlatformCmd,
    #[serde(default)]
    skip_if: Option<PlatformCmd>,
    #[serde(default)]
    auth_wait_for_exit: Option<bool>,
    #[serde(default)]
    auth_url_domain: Option<String>,
    #[serde(default)]
    auth_suppress_browser: Option<bool>,
}

/// One normalized auth step after applying top-level fallbacks.
struct ResolvedStep {
    command: String,
    skip_if: Option<String>,
    wait_for_exit: bool,
    url_domain: Option<String>,
    suppress_browser: bool,
}

// ---------- command results ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatusResult {
    /// cli.json exists for this connector.
    pub has_spec: bool,
    /// versionCheck passed (CLI is installed and new enough).
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cli_version: Option<String>,
    /// status command output matches the authed pattern.
    pub authed: bool,
    /// UI hint: show the auth URL as a QR code (echo-agent `authQrModal`).
    pub qr_modal: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliAuthResult {
    pub ok: bool,
    pub authed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CliAuthUrlEvent {
    source: String,
    url: String,
    qr_modal: bool,
    suppress_browser: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CliAuthLogEvent {
    source: String,
    line: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CliAuthDoneEvent {
    source: String,
    ok: bool,
    authed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

// ---------- process registry (for cancel) ----------

/// PIDs of in-flight auth child processes, keyed by connector source.
fn active_children() -> &'static Mutex<HashMap<String, Vec<u32>>> {
    static ACTIVE: OnceLock<Mutex<HashMap<String, Vec<u32>>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_child(source: &str, pid: u32) {
    active_children()
        .lock()
        .unwrap()
        .entry(source.to_string())
        .or_default()
        .push(pid);
}

fn unregister_child(source: &str, pid: u32) {
    if let Some(v) = active_children().lock().unwrap().get_mut(source) {
        v.retain(|&p| p != pid);
    }
}

fn kill_process_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .output();
    }
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ---------- helpers ----------

fn spec_path(root: &str, source: &str) -> PathBuf {
    PathBuf::from(root)
        .join("connectors")
        .join(source)
        .join("cli.json")
}

fn read_spec(root: &str, source: &str) -> Result<Option<CliSpec>, String> {
    let path = spec_path(root, source);
    crate::paths::reject_legacy_workbuddy_path(&path)?;
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("读取 cli.json 失败：{e}")),
    };
    let spec: CliSpec =
        serde_json::from_str(&raw).map_err(|e| format!("解析 cli.json 失败：{e}"))?;
    Ok(Some(spec))
}

fn platform_key() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "win32"
    }
    #[cfg(target_os = "macos")]
    {
        "darwin"
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        "linux"
    }
}

fn pick_platform(cmd: &PlatformCmd) -> Option<String> {
    cmd.get(platform_key())
        .or_else(|| cmd.get("linux"))
        .or_else(|| cmd.values().next())
        .cloned()
}

fn shell_command(line: &str) -> tokio::process::Command {
    #[cfg(windows)]
    {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/c", line]);
        c.creation_flags(CREATE_NO_WINDOW);
        c
    }
    #[cfg(not(windows))]
    {
        let mut c = tokio::process::Command::new("sh");
        c.args(["-c", line]);
        c
    }
}

/// Run a command to completion, returning (exit_code, combined output).
async fn run_capture(line: &str, timeout: Duration) -> Result<(i32, String), String> {
    let fut = shell_command(line).output();
    let out = tokio::time::timeout(timeout, fut)
        .await
        .map_err(|_| format!("命令超时：{line}"))?
        .map_err(|e| format!("命令启动失败：{line}：{e}"))?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Ok((out.status.code().unwrap_or(-1), text))
}

/// Extract the first `x.y.z` version substring from command output.
fn extract_version(text: &str) -> Option<(u64, u64, u64)> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let mut nums = [0u64; 3];
            let mut j = i;
            let mut n = 0;
            while n < 3 {
                let start = j;
                while j < bytes.len() && bytes[j].is_ascii_digit() {
                    j += 1;
                }
                if start == j {
                    break;
                }
                nums[n] = text[start..j].parse().ok()?;
                n += 1;
                if n < 3 {
                    if j < bytes.len() && bytes[j] == b'.' {
                        j += 1;
                    } else {
                        break;
                    }
                }
            }
            if n == 3 {
                return Some((nums[0], nums[1], nums[2]));
            }
            i = j.max(i + 1);
        } else {
            i += 1;
        }
    }
    None
}

fn version_at_least(found: (u64, u64, u64), min: &str) -> bool {
    let want = extract_version(min).unwrap_or((0, 0, 0));
    found >= want
}

/// Run the versionCheck command; returns (installed, version string).
async fn check_installed(spec: &CliSpec) -> (bool, Option<String>) {
    let Some(vc) = &spec.version_check else {
        // No way to check — assume present so auth can still be attempted.
        return (true, None);
    };
    let Some(line) = pick_platform(&vc.command) else {
        return (false, None);
    };
    let Ok((code, out)) = run_capture(&line, SHORT_TIMEOUT).await else {
        return (false, None);
    };
    if code != 0 {
        return (false, None);
    }
    let ver = extract_version(&out);
    let ok = match (&vc.min_version, ver) {
        (Some(min), Some(v)) => version_at_least(v, min),
        // Found the binary but no parseable version — accept it.
        _ => true,
    };
    (ok, ver.map(|(a, b, c)| format!("{a}.{b}.{c}")))
}

/// Evaluate the `status` command against statusMatch / statusMatchJson.
async fn check_authed(spec: &CliSpec) -> bool {
    let Some(status) = &spec.status else {
        return false;
    };
    let Some(line) = pick_platform(status) else {
        return false;
    };
    let Ok((code, out)) = run_capture(&line, SHORT_TIMEOUT).await else {
        return false;
    };
    if let Some(pattern) = &spec.status_match {
        if let Ok(re) = regex::Regex::new(pattern) {
            return re.is_match(&out);
        }
    }
    if let Some(expect) = &spec.status_match_json {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&out) {
            return expect.iter().all(|(k, want)| {
                v.get(k)
                    .map(|got| {
                        got.as_str()
                            .map(|s| s == want)
                            .unwrap_or_else(|| got.to_string() == *want)
                    })
                    .unwrap_or(false)
            });
        }
        return false;
    }
    // No matcher configured — fall back to exit code.
    code == 0
}

/// Extract the first https URL containing `domain` from a line of output.
fn extract_auth_url(line: &str, domain: &str) -> Option<String> {
    let mut start = 0;
    while let Some(pos) = line[start..].find("https://") {
        let abs = start + pos;
        let rest = &line[abs..];
        let end = rest
            .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '<' || c == '>')
            .unwrap_or(rest.len());
        let candidate = rest[..end].trim_end_matches([')', ']', '}', '.', ',', ';']);
        if candidate.contains(domain) {
            return Some(candidate.to_string());
        }
        start = abs + end.max(1);
    }
    None
}

fn normalize_steps(spec: &CliSpec) -> Vec<ResolvedStep> {
    let mut out = Vec::new();
    match &spec.auth {
        Some(AuthSpec::Steps(steps)) => {
            for s in steps {
                let Some(command) = pick_platform(&s.command) else {
                    continue;
                };
                out.push(ResolvedStep {
                    command,
                    skip_if: s.skip_if.as_ref().and_then(pick_platform),
                    wait_for_exit: s.auth_wait_for_exit.unwrap_or(true),
                    url_domain: s.auth_url_domain.clone(),
                    suppress_browser: s.auth_suppress_browser.unwrap_or(false),
                });
            }
        }
        Some(AuthSpec::Single(cmd)) => {
            if let Some(command) = pick_platform(cmd) {
                out.push(ResolvedStep {
                    command,
                    skip_if: None,
                    wait_for_exit: spec.auth_wait_for_exit.unwrap_or(true),
                    url_domain: spec.auth_url_domain.clone(),
                    suppress_browser: spec.auth_suppress_browser.unwrap_or(false),
                });
            }
        }
        None => {}
    }
    out
}

/// Run one auth step, streaming output lines as events and watching for the
/// auth URL. Returns the exit code.
async fn run_auth_step(
    app: &AppHandle,
    source: &str,
    step: &ResolvedStep,
    qr_modal: bool,
) -> Result<i32, String> {
    use tokio::io::{AsyncBufReadExt, BufReader};

    let mut child = shell_command(&step.command)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("授权命令启动失败：{}：{e}", step.command))?;
    let pid = child.id().unwrap_or(0);
    register_child(source, pid);

    let stdout = child.stdout.take().map(BufReader::new);
    let stderr = child.stderr.take().map(BufReader::new);

    let scan_line = |line: &str| {
        let _ = app.emit(
            "connector://cli-auth-log",
            CliAuthLogEvent {
                source: source.to_string(),
                line: line.to_string(),
            },
        );
        if let Some(domain) = &step.url_domain {
            if let Some(url) = extract_auth_url(line, domain) {
                let _ = app.emit(
                    "connector://cli-auth-url",
                    CliAuthUrlEvent {
                        source: source.to_string(),
                        url,
                        qr_modal,
                        suppress_browser: step.suppress_browser,
                    },
                );
            }
        }
    };

    let mut out_lines = stdout.map(|r| r.lines());
    let mut err_lines = stderr.map(|r| r.lines());

    // Drain stdout/stderr concurrently with waiting on the child.
    let wait = async {
        loop {
            tokio::select! {
                line = async {
                    match out_lines.as_mut() {
                        Some(l) => Some(l.next_line().await),
                        None => None,
                    }
                }, if out_lines.is_some() => {
                    match line {
                        Some(Ok(Some(l))) => scan_line(&l),
                        _ => { out_lines = None; }
                    }
                }
                line = async {
                    match err_lines.as_mut() {
                        Some(l) => Some(l.next_line().await),
                        None => None,
                    }
                }, if err_lines.is_some() => {
                    match line {
                        Some(Ok(Some(l))) => scan_line(&l),
                        _ => { err_lines = None; }
                    }
                }
                status = child.wait() => {
                    // Drain remaining buffered output, then return.
                    while let Some(l) = &mut out_lines {
                        match l.next_line().await {
                            Ok(Some(line)) => scan_line(&line),
                            _ => break,
                        }
                    }
                    while let Some(l) = &mut err_lines {
                        match l.next_line().await {
                            Ok(Some(line)) => scan_line(&line),
                            _ => break,
                        }
                    }
                    return status.map_err(|e| format!("等待授权命令失败：{e}"));
                }
            }
        }
    };

    let result = tokio::time::timeout(STEP_TIMEOUT, wait).await;
    unregister_child(source, pid);
    match result {
        Ok(Ok(status)) => Ok(status.code().unwrap_or(-1)),
        Ok(Err(e)) => Err(e),
        Err(_) => {
            kill_process_tree(pid);
            Err("授权超时（10 分钟），请重试".to_string())
        }
    }
}

// ---------- tauri commands ----------

/// Probe a CLI connector: does it have a cli.json, is the CLI installed, and
/// is it currently authorized?
#[tauri::command]
pub async fn connectors_cli_status(
    root: String,
    source: String,
) -> Result<CliStatusResult, String> {
    let spec = match read_spec(&root, &source)? {
        Some(s) => s,
        None => {
            return Ok(CliStatusResult {
                has_spec: false,
                installed: false,
                cli_version: None,
                authed: false,
                qr_modal: false,
                error: None,
            })
        }
    };
    let (installed, cli_version) = check_installed(&spec).await;
    let authed = if installed {
        check_authed(&spec).await
    } else {
        false
    };
    Ok(CliStatusResult {
        has_spec: true,
        installed,
        cli_version,
        authed,
        qr_modal: spec.auth_qr_modal.unwrap_or(false),
        error: None,
    })
}

/// Full authorization flow: install the CLI if needed, run the auth steps
/// (streaming the auth URL to the UI), then re-check status. Long-running —
/// resolves when the flow completes, fails, or times out.
#[tauri::command]
pub async fn connectors_cli_auth(
    app: AppHandle,
    root: String,
    source: String,
) -> Result<CliAuthResult, String> {
    let finish = |res: CliAuthResult| {
        let _ = app.emit(
            "connector://cli-auth-done",
            CliAuthDoneEvent {
                source: source.clone(),
                ok: res.ok,
                authed: res.authed,
                error: res.error.clone(),
            },
        );
        res
    };

    let spec = match read_spec(&root, &source)? {
        Some(s) => s,
        None => {
            return Ok(finish(CliAuthResult {
                ok: false,
                authed: false,
                error: Some("该连接器没有 cli.json".into()),
            }))
        }
    };

    // 1. Ensure the CLI is installed (run `init` when the version check fails).
    let (mut installed, _) = check_installed(&spec).await;
    if !installed {
        if let Some(init) = &spec.init {
            if let Some(line) = pick_platform(init) {
                let _ = app.emit(
                    "connector://cli-auth-log",
                    CliAuthLogEvent {
                        source: source.clone(),
                        line: format!("正在安装 CLI：{line}"),
                    },
                );
                match run_capture(&line, Duration::from_secs(300)).await {
                    Ok((0, _)) => {
                        installed = check_installed(&spec).await.0;
                    }
                    Ok((code, out)) => {
                        return Ok(finish(CliAuthResult {
                            ok: false,
                            authed: false,
                            error: Some(format!(
                                "CLI 安装失败（退出码 {code}）：{}",
                                out.lines().last().unwrap_or("").trim()
                            )),
                        }));
                    }
                    Err(e) => {
                        return Ok(finish(CliAuthResult {
                            ok: false,
                            authed: false,
                            error: Some(e),
                        }));
                    }
                }
            }
        }
        if !installed {
            return Ok(finish(CliAuthResult {
                ok: false,
                authed: false,
                error: Some("CLI 未安装，且 cli.json 未提供安装命令".into()),
            }));
        }
    }

    // 2. Already authorized? Skip the whole flow.
    if check_authed(&spec).await {
        return Ok(finish(CliAuthResult {
            ok: true,
            authed: true,
            error: None,
        }));
    }

    // 3. Run the auth steps.
    let steps = normalize_steps(&spec);
    if steps.is_empty() {
        return Ok(finish(CliAuthResult {
            ok: false,
            authed: false,
            error: Some("cli.json 没有授权命令".into()),
        }));
    }
    let qr_modal = spec.auth_qr_modal.unwrap_or(false);
    for step in &steps {
        // skipIf: exit 0 means this step is already satisfied.
        if let Some(skip) = &step.skip_if {
            if let Ok((0, _)) = run_capture(skip, SHORT_TIMEOUT).await {
                continue;
            }
        }
        match run_auth_step(&app, &source, step, qr_modal).await {
            Ok(0) => {}
            Ok(code) => {
                return Ok(finish(CliAuthResult {
                    ok: false,
                    authed: false,
                    error: Some(format!("授权命令退出码 {code}")),
                }));
            }
            Err(e) => {
                let cancelled = e.contains("授权超时");
                return Ok(finish(CliAuthResult {
                    ok: false,
                    authed: false,
                    error: Some(if cancelled {
                        e
                    } else {
                        format!("授权失败：{e}")
                    }),
                }));
            }
        }
        if !step.wait_for_exit {
            continue;
        }
    }

    // 4. Verify.
    let authed = check_authed(&spec).await;
    Ok(finish(CliAuthResult {
        ok: authed,
        authed,
        error: if authed {
            None
        } else {
            Some("授权流程结束，但未检测到已授权状态".into())
        },
    }))
}

/// Cancel an in-flight authorization for a connector (kills the child tree).
#[tauri::command]
pub async fn connectors_cli_auth_cancel(source: String) -> Result<(), String> {
    let pids: Vec<u32> = active_children()
        .lock()
        .unwrap()
        .get(&source)
        .cloned()
        .unwrap_or_default();
    for pid in pids {
        kill_process_tree(pid);
    }
    Ok(())
}

/// Run the connector's unAuth command (logout / credential wipe).
#[tauri::command]
pub async fn connectors_cli_unauth(root: String, source: String) -> Result<(), String> {
    let spec = read_spec(&root, &source)?.ok_or("该连接器没有 cli.json")?;
    let un_auth = spec.un_auth.ok_or("cli.json 没有 unAuth 命令")?;
    let line = pick_platform(&un_auth).ok_or("当前平台不支持 unAuth")?;
    let (code, out) = run_capture(&line, SHORT_TIMEOUT).await?;
    if code != 0 {
        return Err(format!(
            "取消授权失败（退出码 {code}）：{}",
            out.lines().last().unwrap_or("").trim()
        ));
    }
    Ok(())
}

/// Absolute path of the connector's bundled `skills/` directory, if it exists
/// (CLI connectors ship agent skills that are installed after authorization).
#[tauri::command]
pub async fn connectors_cli_skills_dir(
    root: String,
    source: String,
) -> Result<Option<String>, String> {
    let dir = PathBuf::from(root)
        .join("connectors")
        .join(&source)
        .join("skills");
    crate::paths::reject_legacy_workbuddy_path(&dir)?;
    Ok(if dir.is_dir() {
        Some(dir.to_string_lossy().into_owned())
    } else {
        None
    })
}
