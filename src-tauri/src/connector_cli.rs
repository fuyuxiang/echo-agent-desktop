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
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Default per-step wait when `authWaitForExit` is absent: if the step has a
/// URL domain we wait (user must complete the web flow); otherwise a plain
/// command just runs to completion anyway.
const STEP_TIMEOUT: Duration = Duration::from_secs(600);
const SHORT_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_CLI_SPEC_BYTES: u64 = 1024 * 1024;
const MAX_COMMAND_BYTES: usize = 4096;
const MAX_CAPTURE_BYTES: usize = 1024 * 1024;
const MAX_AUTH_SCAN_BYTES: usize = 2 * 1024 * 1024;
const MAX_AUTH_LINE_BYTES: usize = 16 * 1024;
const MAX_AUTH_LOG_EVENTS: usize = 2_000;

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

struct LoadedCliSpec {
    spec: CliSpec,
    /// Canonical spec path plus a digest of the exact bytes approved by the
    /// user. Editing cli.json invalidates trust immediately.
    trust_key: String,
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

fn trusted_specs() -> &'static Mutex<std::collections::HashSet<String>> {
    static TRUSTED: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    TRUSTED.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
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
        let _ = std::process::Command::new("/bin/kill")
            // Negative PID targets the dedicated process group created in
            // `shell_command`, including grandchildren.
            .args(["-KILL", &format!("-{pid}")])
            .output();
    }
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ---------- helpers ----------

fn spec_path(root: &str, source: &str) -> Result<PathBuf, String> {
    Ok(
        crate::connectors_catalog::canonical_executable_connector_dir(root, source)?
            .join("cli.json"),
    )
}

fn read_spec(root: &str, source: &str) -> Result<Option<LoadedCliSpec>, String> {
    let path = spec_path(root, source)?;
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取 cli.json 失败：{error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("cli.json 必须是连接器目录内的普通文件".into());
    }
    if metadata.len() > MAX_CLI_SPEC_BYTES {
        return Err("cli.json 超过 1MB 限制".into());
    }
    let raw = crate::shell_fs::read_regular_file_bounded(&path, MAX_CLI_SPEC_BYTES)
        .and_then(|bytes| {
            String::from_utf8(bytes).map_err(|e| format!("cli.json 必须是 UTF-8 文本：{e}"))
        })
        .map_err(|e| format!("读取 cli.json 失败：{e}"))?;
    let spec: CliSpec =
        serde_json::from_str(&raw).map_err(|e| format!("解析 cli.json 失败：{e}"))?;
    let digest = Sha256::digest(raw.as_bytes());
    let fingerprint = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(Some(LoadedCliSpec {
        spec,
        trust_key: format!("{}:{fingerprint}", path.to_string_lossy()),
    }))
}

fn validate_command(line: &str) -> Result<&str, String> {
    let line = line.trim();
    if line.is_empty()
        || line.len() > MAX_COMMAND_BYTES
        || line.contains('\0')
        || line.contains('\r')
        || line.contains('\n')
        || line
            .chars()
            .any(|character| character.is_control() && character != '\t')
    {
        return Err("连接器命令为空、过长或包含控制字符".into());
    }
    Ok(line)
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
    // Never execute a command authored for another operating system. Besides
    // being unreliable, fallback-to-any-value can reinterpret quoting under a
    // different shell with surprising results.
    cmd.get(platform_key()).cloned()
}

fn commands_for_confirmation(spec: &CliSpec) -> Result<Vec<String>, String> {
    let mut commands = Vec::new();
    let mut push = |command: Option<String>| -> Result<(), String> {
        if let Some(command) = command {
            let command = validate_command(&command)?.to_string();
            if !commands.contains(&command) {
                commands.push(command);
            }
        }
        Ok(())
    };
    push(spec.init.as_ref().and_then(pick_platform))?;
    push(
        spec.version_check
            .as_ref()
            .and_then(|check| pick_platform(&check.command)),
    )?;
    match &spec.auth {
        Some(AuthSpec::Steps(steps)) => {
            if steps.len() > 64 {
                return Err("cli.json 授权步骤超过 64 个上限".into());
            }
            for step in steps {
                push(pick_platform(&step.command))?;
                push(step.skip_if.as_ref().and_then(pick_platform))?;
            }
        }
        Some(AuthSpec::Single(command)) => push(pick_platform(command))?,
        None => {}
    }
    push(spec.status.as_ref().and_then(pick_platform))?;
    push(spec.un_auth.as_ref().and_then(pick_platform))?;
    Ok(commands)
}

fn confirm_spec_execution(app: &AppHandle, loaded: &LoadedCliSpec) -> Result<(), String> {
    if trusted_specs()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains(&loaded.trust_key)
    {
        return Ok(());
    }
    let commands = commands_for_confirmation(&loaded.spec)?;
    if commands.is_empty() {
        return Err("cli.json 没有当前平台可执行的命令".into());
    }
    let mut details = commands
        .iter()
        .take(12)
        .enumerate()
        .map(|(index, command)| format!("{}. {command}", index + 1))
        .collect::<Vec<_>>()
        .join("\n");
    if commands.len() > 12 {
        details.push_str(&format!("\n…另有 {} 条命令", commands.len() - 12));
    }
    let approved = app
        .dialog()
        .message(format!(
            "连接器将以当前用户权限执行本地 shell 命令（本次进程内信任，cli.json 变更后失效）：\n\n{details}"
        ))
        .title("允许连接器执行本地命令？")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "允许本次".into(),
            "取消".into(),
        ))
        .blocking_show();
    if !approved {
        return Err("用户取消了连接器命令执行".into());
    }
    trusted_specs()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(loaded.trust_key.clone());
    Ok(())
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
        // Put the shell and every descendant in a dedicated process group so
        // timeout/cancel can terminate the whole connector command tree.
        c.process_group(0);
        c
    }
}

/// Run a command to completion, returning (exit_code, combined output).
async fn run_capture(line: &str, timeout: Duration) -> Result<(i32, String), String> {
    use tokio::io::AsyncReadExt;

    let line = validate_command(line)?;
    let mut child = shell_command(line)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("命令启动失败：{line}：{e}"))?;
    let pid = child.id().ok_or("连接器命令启动后未返回进程 ID")?;
    let mut stdout = child.stdout.take().ok_or("无法捕获命令 stdout")?;
    let mut stderr = child.stderr.take().ok_or("无法捕获命令 stderr")?;

    async fn drain_capped(
        stream: &mut (impl tokio::io::AsyncRead + Unpin),
    ) -> std::io::Result<(Vec<u8>, bool)> {
        let mut kept = Vec::new();
        let mut buffer = [0_u8; 8192];
        let mut truncated = false;
        loop {
            let read = stream.read(&mut buffer).await?;
            if read == 0 {
                break;
            }
            let remaining = MAX_CAPTURE_BYTES.saturating_sub(kept.len());
            if remaining > 0 {
                kept.extend_from_slice(&buffer[..read.min(remaining)]);
            }
            truncated |= read > remaining;
        }
        Ok((kept, truncated))
    }

    let execution = async {
        let (status, stdout, stderr) = tokio::try_join!(
            child.wait(),
            drain_capped(&mut stdout),
            drain_capped(&mut stderr)
        )?;
        Ok::<_, std::io::Error>((status, stdout, stderr))
    };
    let (status, (stdout, stdout_truncated), (stderr, stderr_truncated)) =
        match tokio::time::timeout(timeout, execution).await {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => {
                kill_process_tree(pid);
                let _ = child.kill().await;
                return Err(format!("命令执行失败：{line}：{error}"));
            }
            Err(_) => {
                kill_process_tree(pid);
                let _ = child.kill().await;
                return Err(format!("命令超时：{line}"));
            }
        };
    let mut text = String::from_utf8_lossy(&stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&stderr));
    if stdout_truncated || stderr_truncated {
        text.push_str("\n…(连接器命令输出已截断)");
    }
    Ok((status.code().unwrap_or(-1), text))
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
                        got.as_str().map(|s| s == want).unwrap_or_else(|| {
                            serde_json::from_str::<serde_json::Value>(want)
                                .map(|parsed| got == &parsed)
                                .unwrap_or(false)
                        })
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
    let allowed = if let Ok(url) = url::Url::parse(domain) {
        url.host_str()?
            .trim_matches(['[', ']'])
            .to_ascii_lowercase()
    } else {
        url::Url::parse(&format!("https://{}", domain.trim().trim_matches('/')))
            .ok()?
            .host_str()?
            .trim_matches(['[', ']'])
            .to_ascii_lowercase()
    };
    let mut start = 0;
    while let Some(pos) = line[start..].find("https://") {
        let abs = start + pos;
        let rest = &line[abs..];
        let end = rest
            .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '<' || c == '>')
            .unwrap_or(rest.len());
        let candidate = rest[..end].trim_end_matches([')', ']', '}', '.', ',', ';']);
        if let Ok(parsed) = url::Url::parse(candidate) {
            let host = parsed
                .host_str()
                .unwrap_or_default()
                .trim_matches(['[', ']'])
                .to_ascii_lowercase();
            let host_matches = host == allowed
                || (!allowed.parse::<std::net::IpAddr>().is_ok()
                    && host
                        .strip_suffix(&allowed)
                        .is_some_and(|prefix| prefix.ends_with('.')));
            if parsed.scheme() == "https"
                && parsed.username().is_empty()
                && parsed.password().is_none()
                && host_matches
            {
                return Some(parsed.to_string());
            }
        }
        start = abs + end.max(1);
    }
    None
}

struct AuthOutputConfig<'a> {
    source: &'a str,
    domain: Option<&'a str>,
    qr_modal: bool,
    suppress_browser: bool,
}

#[derive(Default)]
struct AuthOutputState {
    emitted_logs: usize,
    emitted_url: bool,
}

fn emit_auth_output_line(
    app: &AppHandle,
    config: &AuthOutputConfig<'_>,
    bytes: &[u8],
    state: &mut AuthOutputState,
) {
    let line = String::from_utf8_lossy(bytes);
    // Prevent terminal control sequences/newlines from forging adjacent UI
    // records. Tabs are retained for readable CLI formatting.
    let line = line
        .chars()
        .filter(|character| !character.is_control() || *character == '\t')
        .collect::<String>();
    if state.emitted_logs < MAX_AUTH_LOG_EVENTS {
        let _ = app.emit(
            "connector://cli-auth-log",
            CliAuthLogEvent {
                source: config.source.to_string(),
                line: line.clone(),
            },
        );
        state.emitted_logs += 1;
    }
    if !state.emitted_url {
        if let Some(url) = config
            .domain
            .and_then(|domain| extract_auth_url(&line, domain))
        {
            let _ = app.emit(
                "connector://cli-auth-url",
                CliAuthUrlEvent {
                    source: config.source.to_string(),
                    url,
                    qr_modal: config.qr_modal,
                    suppress_browser: config.suppress_browser,
                },
            );
            state.emitted_url = true;
        }
    }
}

async fn drain_auth_output(
    mut stream: impl tokio::io::AsyncRead + Unpin,
    app: &AppHandle,
    source: &str,
    domain: Option<&str>,
    qr_modal: bool,
    suppress_browser: bool,
) -> std::io::Result<()> {
    use tokio::io::AsyncReadExt;

    let mut buffer = [0_u8; 8192];
    let mut pending = Vec::with_capacity(1024);
    let mut scanned = 0_usize;
    let config = AuthOutputConfig {
        source,
        domain,
        qr_modal,
        suppress_browser,
    };
    let mut output_state = AuthOutputState::default();
    let mut dropping_long_line = false;
    loop {
        let read = stream.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        let remaining = MAX_AUTH_SCAN_BYTES.saturating_sub(scanned);
        let inspect = read.min(remaining);
        scanned = scanned.saturating_add(read);
        for byte in &buffer[..inspect] {
            if *byte == b'\n' {
                if !pending.is_empty() || !dropping_long_line {
                    emit_auth_output_line(app, &config, &pending, &mut output_state);
                }
                pending.clear();
                dropping_long_line = false;
            } else if pending.len() < MAX_AUTH_LINE_BYTES {
                pending.push(*byte);
            } else {
                dropping_long_line = true;
            }
        }
    }
    if !pending.is_empty() {
        emit_auth_output_line(app, &config, &pending, &mut output_state);
    }
    Ok(())
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
    let command = validate_command(&step.command)?;
    let mut child = shell_command(command)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("授权命令启动失败：{command}：{e}"))?;
    let pid = child.id().ok_or("授权命令启动后未返回进程 ID")?;
    register_child(source, pid);

    let stdout = child.stdout.take().ok_or("无法捕获授权命令 stdout")?;
    let stderr = child.stderr.take().ok_or("无法捕获授权命令 stderr")?;
    let execution = async {
        let (status, (), ()) = tokio::try_join!(
            child.wait(),
            drain_auth_output(
                stdout,
                app,
                source,
                step.url_domain.as_deref(),
                qr_modal,
                step.suppress_browser,
            ),
            drain_auth_output(
                stderr,
                app,
                source,
                step.url_domain.as_deref(),
                qr_modal,
                step.suppress_browser,
            )
        )?;
        Ok::<_, std::io::Error>(status)
    };

    let result = tokio::time::timeout(STEP_TIMEOUT, execution).await;
    unregister_child(source, pid);
    match result {
        Ok(Ok(status)) => Ok(status.code().unwrap_or(-1)),
        Ok(Err(error)) => {
            kill_process_tree(pid);
            let _ = child.kill().await;
            Err(format!("等待授权命令失败：{error}"))
        }
        Err(_) => {
            kill_process_tree(pid);
            let _ = child.kill().await;
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
    let loaded = match read_spec(&root, &source)? {
        Some(loaded) => loaded,
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
    if !trusted_specs()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains(&loaded.trust_key)
    {
        return Ok(CliStatusResult {
            has_spec: true,
            installed: false,
            cli_version: None,
            authed: false,
            qr_modal: loaded.spec.auth_qr_modal.unwrap_or(false),
            error: Some("尚未允许该连接器执行本地命令；请点击连接并审核命令".into()),
        });
    }
    let spec = loaded.spec;
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

    let loaded = match read_spec(&root, &source)? {
        Some(loaded) => loaded,
        None => {
            return Ok(finish(CliAuthResult {
                ok: false,
                authed: false,
                error: Some("该连接器没有 cli.json".into()),
            }))
        }
    };
    confirm_spec_execution(&app, &loaded)?;
    let spec = loaded.spec;

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
    crate::connectors_catalog::validate_connector_source(&source)?;
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
pub async fn connectors_cli_unauth(
    app: AppHandle,
    root: String,
    source: String,
) -> Result<(), String> {
    let loaded = read_spec(&root, &source)?.ok_or("该连接器没有 cli.json")?;
    confirm_spec_execution(&app, &loaded)?;
    let spec = loaded.spec;
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
    let connector = crate::connectors_catalog::canonical_executable_connector_dir(&root, &source)?;
    let dir = connector.join("skills");
    if !dir.exists() {
        return Ok(None);
    }
    let dir = dir
        .canonicalize()
        .map_err(|error| format!("无法解析连接器 skills 目录：{error}"))?;
    if !dir.is_dir() || dir.parent() != Some(connector.as_path()) {
        return Err("连接器 skills 目录越出连接器边界".into());
    }
    Ok(Some(dir.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_url_requires_exact_https_domain_boundary() {
        assert_eq!(
            extract_auth_url(
                "open https://login.example.com/oauth?code=1 now",
                "example.com"
            )
            .as_deref(),
            Some("https://login.example.com/oauth?code=1")
        );
        assert!(
            extract_auth_url("https://example.com.attacker.invalid/oauth", "example.com").is_none()
        );
        assert!(
            extract_auth_url("https://attacker.invalid/?next=example.com", "example.com").is_none()
        );
        assert!(extract_auth_url("http://example.com/oauth", "example.com").is_none());
    }

    #[test]
    fn platform_commands_do_not_fall_back_to_another_os() {
        let mut commands = PlatformCmd::new();
        commands.insert("definitely-not-this-platform".into(), "dangerous".into());
        assert!(pick_platform(&commands).is_none());
        commands.insert(platform_key().into(), "expected".into());
        assert_eq!(pick_platform(&commands).as_deref(), Some("expected"));
    }

    #[test]
    fn connector_commands_reject_multiline_injection() {
        assert!(validate_command("echo safe").is_ok());
        assert!(validate_command("echo safe\nrm -rf target").is_err());
        assert!(validate_command(&"x".repeat(MAX_COMMAND_BYTES + 1)).is_err());
    }
}
