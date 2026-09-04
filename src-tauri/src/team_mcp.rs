//! EchoAgent 内嵌 MCP server —— 团队工具的非侵入式实现。
//!
//! `create_team` / `team_status` / `team_delete` 通过本模块提供的**标准 MCP
//! streamable-http server** 实现（仅监听
//! 127.0.0.1），EchoAgent 作为 MCP client 连接，工具以 `echoagent__create_team`
//! 等名字出现，不需要修改内嵌 Runtime 的团队工具启用集。
//!
//! 注册路径（双保险）：
//!  1. `agent_runtime::new_session` 时通过 ACP `mcp_servers` 参数传入 —— 会话立即可用
//!     （merge 层中 client 层优先级最高，见 EchoAgent `managed_mcp.rs`）。
//!  2. 首个会话建立后调用 `echo.agent/mcp/upsert` 持久化到 config.toml（EchoAgent 自己
//!     写盘）—— `load_session` 恢复的会话也能用（EchoAgent 会话启动时从
//!     config.toml 加载 MCP server 列表）。
//!
//! 状态：团队数据持久化到 `~/.echo-agent/echoagent-teams.json`，应用/agent 重启
//! 不丢（旧实现里 TEAMS 在 EchoAgent 进程内存中，agent 崩溃重启即丢）。
//!
//! MCP 协议子集（streamable HTTP, MCP 2025-03-26 / 2025-06-18 兼容）：
//!   POST /mcp  — JSON-RPC: initialize / ping / tools/list / tools/call；
//!                 通知（无 id）返回 202。
//!   GET  /mcp  — 405（服务端不主动推流，规范允许）。
//!   DELETE /mcp — 405（无会话状态可删）。

use axum::{
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Router,
};
use fs2::FileExt;
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

// ---------- 团队状态（进程级 + 磁盘持久化）----------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TeamInfo {
    pub team_id: String,
    pub members: Vec<TeamMember>,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TeamMember {
    pub name: String,
    pub file: String,
}

/// Every store operation takes this process lock before the stable on-disk
/// lock. Keeping one lock order avoids deadlocks and makes atomic replacement
/// safe across threads as well as across EchoAgent processes.
static TEAM_STORE_TRANSACTION: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSnapshotEntry {
    pub team_id: String,
    pub members: Vec<String>,
    pub created_at: u64,
}

/// Desktop UI snapshot of the authoritative, persisted team registry.
/// Keeping this command beside the MCP implementation prevents the renderer
/// from trying to reconstruct durable state from one conversation transcript.
#[tauri::command]
pub fn team_snapshot() -> Result<Vec<TeamSnapshotEntry>, String> {
    let teams = read_teams_from_disk()?;
    let mut result = teams
        .values()
        .map(|team| TeamSnapshotEntry {
            team_id: team.team_id.clone(),
            members: team
                .members
                .iter()
                .map(|member| member.name.clone())
                .collect(),
            created_at: team.created_at,
        })
        .collect::<Vec<_>>();
    result.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| a.team_id.cmp(&b.team_id))
    });
    Ok(result)
}

/// `~/.echo-agent/echoagent-teams.json` —— 与 EchoAgent 配置同目录，方便用户备份。
fn teams_file() -> PathBuf {
    crate::paths::echo_agent_home_dir().join("echoagent-teams.json")
}

fn team_store_lock_path(path: &Path) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("团队状态路径没有父目录：{}", path.display()))?;
    let name = path
        .file_name()
        .ok_or_else(|| format!("团队状态路径没有文件名：{}", path.display()))?;
    Ok(parent.join(format!("{}.lock", name.to_string_lossy())))
}

fn acquire_team_store_lock(path: &Path) -> Result<File, String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("团队状态路径没有父目录：{}", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|error| format!("创建团队状态目录失败：{error}"))?;
    let parent_metadata = std::fs::symlink_metadata(parent)
        .map_err(|error| format!("检查团队状态目录失败：{error}"))?;
    if parent_metadata.file_type().is_symlink() || !parent_metadata.is_dir() {
        return Err("团队状态目录必须是真实目录，不能是符号链接".into());
    }
    crate::paths::harden_private_dir(parent)?;

    let lock_path = team_store_lock_path(path)?;
    match std::fs::symlink_metadata(&lock_path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err("团队状态锁必须是普通文件，不能是符号链接".into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("检查团队状态锁失败：{error}")),
    }

    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    options
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options
        .open(&lock_path)
        .map_err(|error| format!("打开团队状态锁失败：{error}"))?;
    let opened_lock_metadata = file
        .metadata()
        .map_err(|error| format!("检查已打开的团队状态锁失败：{error}"))?;
    if opened_lock_metadata.file_type().is_symlink() || !opened_lock_metadata.is_file() {
        return Err("团队状态锁在打开期间被替换".into());
    }
    crate::paths::harden_private_file(&lock_path)?;

    for _ in 0..TEAM_STORE_LOCK_ATTEMPTS {
        match FileExt::try_lock_exclusive(&file) {
            Ok(()) => return Ok(file),
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.raw_os_error() == fs2::lock_contended_error().raw_os_error() =>
            {
                std::thread::sleep(TEAM_STORE_LOCK_RETRY_DELAY);
            }
            Err(error) => return Err(format!("锁定团队状态失败：{error}")),
        }
    }
    Err("等待其他 EchoAgent 实例保存团队状态超时，请稍后重试".into())
}

fn with_team_store_access_at<T>(
    path: &Path,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _process_guard = TEAM_STORE_TRANSACTION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let file = acquire_team_store_lock(path)?;
    let result = operation();
    let unlock = FileExt::unlock(&file).map_err(|error| format!("解锁团队状态失败：{error}"));
    match (result, unlock) {
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Ok(value), Ok(())) => Ok(value),
    }
}

fn quarantine_invalid_team_store(path: &Path, reason: &str) -> String {
    let backup = path.with_extension(format!("json.corrupt.{}", uuid::Uuid::now_v7().simple()));
    if let Err(error) = std::fs::rename(path, &backup) {
        tracing::warn!(path = %path.display(), %error, "failed to quarantine invalid team store");
        format!(
            "团队状态文件损坏或不安全（{reason}），且隔离失败：{error}。原文件未被覆盖，请手动检查 {}",
            path.display()
        )
    } else {
        let _ = crate::paths::harden_private_file(&backup);
        tracing::warn!(path = %path.display(), backup = %backup.display(), "invalid team store was quarantined");
        format!(
            "团队状态文件损坏或不安全（{reason}），已隔离至 {}。请检查备份后重试",
            backup.display()
        )
    }
}

fn load_teams_from_disk_at(path: &Path) -> Result<HashMap<String, TeamInfo>, String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(HashMap::new());
        }
        Err(error) => return Err(format!("读取团队状态失败：{error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("团队状态必须是普通文件，不能是符号链接或目录".into());
    }
    if metadata.len() > MAX_TEAM_STORE_BYTES {
        return Err(quarantine_invalid_team_store(path, "超过 4MB 上限"));
    }

    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options
        .open(path)
        .map_err(|error| format!("打开团队状态失败：{error}"))?;
    let opened_metadata = file
        .metadata()
        .map_err(|error| format!("检查已打开的团队状态失败：{error}"))?;
    if opened_metadata.file_type().is_symlink() || !opened_metadata.is_file() {
        return Err("团队状态在打开期间被替换为非普通文件".into());
    }
    if opened_metadata.len() > MAX_TEAM_STORE_BYTES {
        return Err(quarantine_invalid_team_store(path, "超过 4MB 上限"));
    }
    let mut bytes = Vec::new();
    if file
        .take(MAX_TEAM_STORE_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取团队状态失败：{error}"))?
        > MAX_TEAM_STORE_BYTES as usize
        || bytes.len() as u64 > MAX_TEAM_STORE_BYTES
    {
        return Err(quarantine_invalid_team_store(path, "超过 4MB 上限"));
    }
    let teams: HashMap<String, TeamInfo> = serde_json::from_slice(&bytes)
        .map_err(|error| quarantine_invalid_team_store(path, &format!("JSON 无效：{error}")))?;
    validate_team_store(&teams).map_err(|error| quarantine_invalid_team_store(path, &error))?;
    Ok(teams)
}

fn save_teams_to_disk_at(path: &Path, teams: &HashMap<String, TeamInfo>) -> Result<(), String> {
    validate_team_store(teams)?;
    let contents =
        serde_json::to_vec_pretty(teams).map_err(|error| format!("序列化团队状态失败：{error}"))?;
    if contents.len() as u64 > MAX_TEAM_STORE_BYTES {
        return Err("团队状态超过 4MB 上限".into());
    }
    crate::paths::write_private_file(path, &contents)
        .map_err(|error| format!("保存团队状态失败：{error}"))
}

fn read_teams_from_disk() -> Result<HashMap<String, TeamInfo>, String> {
    let path = teams_file();
    with_team_store_access_at(&path, || load_teams_from_disk_at(&path))
}

fn update_teams_at<T>(
    path: &Path,
    operation: impl FnOnce(&mut HashMap<String, TeamInfo>) -> Result<T, String>,
) -> Result<T, String> {
    with_team_store_access_at(path, || {
        let mut teams = load_teams_from_disk_at(path)?;
        let result = operation(&mut teams)?;
        save_teams_to_disk_at(path, &teams)?;
        Ok(result)
    })
}

fn update_teams<T>(
    operation: impl FnOnce(&mut HashMap<String, TeamInfo>) -> Result<T, String>,
) -> Result<T, String> {
    let path = teams_file();
    update_teams_at(&path, operation)
}

// ---------- server 生命周期 ----------

pub const MCP_SERVER_NAME: &str = "echoagent";
pub const AUTH_HEADER: &str = "Authorization";
const MAX_MCP_BODY_BYTES: usize = 256 * 1024;
const MAX_TEAM_STORE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_TEAMS: usize = 256;
const MAX_TEAM_MEMBERS: usize = 64;
const MAX_TEAM_ID_CHARS: usize = 80;
const MAX_TEAM_ID_BYTES: usize = 320;
const MAX_MEMBER_NAME_CHARS: usize = 80;
const MAX_MEMBER_NAME_BYTES: usize = 320;
const MAX_MEMBER_FILE_BYTES: usize = 16 * 1024;
const MAX_MEMBER_ROLE_CHARS: usize = 500;
const MAX_MEMBER_ROLE_BYTES: usize = 2_000;
const MAX_TEAM_DESCRIPTION_CHARS: usize = 4_096;
const MAX_TEAM_DESCRIPTION_BYTES: usize = 16 * 1024;
const MAX_TOOL_ARGUMENT_BYTES: usize = 128 * 1024;
const MAX_TOOL_OUTPUT_TEXT_BYTES: usize = 256 * 1024;
const MAX_TOOL_ERROR_TEXT_BYTES: usize = 16 * 1024;
const MAX_RPC_METHOD_BYTES: usize = 128;
const MAX_RPC_ID_STRING_BYTES: usize = 256;
const MAX_RPC_RESPONSE_BYTES: usize = 384 * 1024;
const MAX_AVAILABLE_AGENT_SCAN_ENTRIES: usize = 1_024;
const MAX_AVAILABLE_AGENT_NAMES: usize = 128;
const TEAM_STORE_LOCK_ATTEMPTS: usize = 200;
const TEAM_STORE_LOCK_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(10);

fn normalized_team_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().count() > MAX_TEAM_ID_CHARS
        || value.len() > MAX_TEAM_ID_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(format!("团队 ID 必须为 1–{MAX_TEAM_ID_CHARS} 个非控制字符"));
    }
    Ok(value.to_string())
}

fn normalized_member_name(value: &str) -> Result<String, String> {
    let name = value.trim();
    if name.is_empty()
        || name.chars().count() > MAX_MEMBER_NAME_CHARS
        || name.len() > MAX_MEMBER_NAME_BYTES
        || name.chars().any(char::is_control)
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.ends_with(".md")
    {
        return Err(format!(
            "成员名 '{name}' 非法：必须是 1–{MAX_MEMBER_NAME_CHARS} 个非控制字符，且不能包含路径分隔符、'..' 或 '.md' 后缀"
        ));
    }
    Ok(name.to_string())
}

fn validate_team_store(teams: &HashMap<String, TeamInfo>) -> Result<(), String> {
    if teams.len() > MAX_TEAMS {
        return Err(format!("团队数量超过 {MAX_TEAMS} 个上限"));
    }
    for (key, team) in teams {
        let normalized_id = normalized_team_id(key)?;
        if normalized_id != *key || team.team_id != *key {
            return Err("团队状态中的 ID 不一致或含有多余空白".into());
        }
        if team.members.is_empty() || team.members.len() > MAX_TEAM_MEMBERS {
            return Err(format!(
                "团队 '{}' 成员数必须为 1–{MAX_TEAM_MEMBERS}",
                team.team_id
            ));
        }
        let mut names = std::collections::HashSet::with_capacity(team.members.len());
        for member in &team.members {
            let normalized_name = normalized_member_name(&member.name)?;
            if normalized_name != member.name {
                return Err(format!("团队 '{}' 的成员名含有多余空白", team.team_id));
            }
            if !names.insert(member.name.as_str()) {
                return Err(format!(
                    "团队 '{}' 包含重复成员 '{}'",
                    team.team_id, member.name
                ));
            }
            let expected_name = format!("{}.md", member.name);
            let stored_path = Path::new(&member.file);
            if member.file.is_empty()
                || member.file.len() > MAX_MEMBER_FILE_BYTES
                || member.file.chars().any(char::is_control)
                || !stored_path.is_absolute()
                || stored_path
                    .components()
                    .any(|component| matches!(component, std::path::Component::ParentDir))
                || stored_path.file_name().and_then(|value| value.to_str())
                    != Some(expected_name.as_str())
            {
                return Err(format!(
                    "团队 '{}' 的成员 '{}' 文件路径无效",
                    team.team_id, member.name
                ));
            }
        }
    }
    Ok(())
}

static BOUND_PORT: OnceLock<u16> = OnceLock::new();
static PROCESS_TOKEN: OnceLock<String> = OnceLock::new();

#[derive(Clone)]
struct ServerState {
    /// Full Authorization value, including the Bearer scheme.
    authorization: String,
    /// Exact authority emitted by `server_url`; prevents Host-header rebinding.
    expected_host: String,
}

/// EchoAgent 的 MCP client 是否已完成 initialize 握手（诊断/测试用）。
static CLIENT_INITIALIZED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// 诊断：EchoAgent（或测试）是否已连上并完成 MCP initialize。
#[cfg(test)]
pub fn client_connected() -> bool {
    CLIENT_INITIALIZED.load(std::sync::atomic::Ordering::SeqCst)
}

/// 启动 server（幂等）：同步 bind（端口即刻确定，供 `server_url()` 使用），
/// accept 循环丢给 tokio。在应用启动时调用一次。
pub fn serve() {
    static SERVED: OnceLock<()> = OnceLock::new();
    if SERVED.set(()).is_err() {
        return; // 已启动过
    }
    let Some(listener) = bind_loopback() else {
        tracing::error!("team MCP server: unable to bind an ephemeral loopback port");
        return;
    };
    let address = match listener.local_addr() {
        Ok(address) => address,
        Err(error) => {
            tracing::error!(%error, "team MCP server: unable to read bound address");
            return;
        }
    };
    let port = address.port();
    // Two UUIDv7 values provide a per-process, unguessable bearer credential
    // without persisting another long-lived secret on disk.
    let token = format!(
        "{}{}",
        uuid::Uuid::now_v7().simple(),
        uuid::Uuid::now_v7().simple()
    );
    let authorization = format!("Bearer {token}");
    let _ = BOUND_PORT.set(port);
    let _ = PROCESS_TOKEN.set(token);
    tracing::info!(port, "team MCP server listening");
    // tauri::async_runtime：serve() 在 Tauri Builder.run() 之前调用，此刻
    // 还没有 tokio 上下文，tokio::spawn 会 panic；tauri 的全局 runtime 可以。
    // std → tokio 转换放进 async 块（需要 IO runtime 上下文）。
    tauri::async_runtime::spawn(async move {
        let listener = match to_tokio_listener(listener) {
            Ok(l) => l,
            Err(e) => {
                tracing::error!(error = %e, "team MCP server: listener conversion failed");
                return;
            }
        };
        let app = Router::new()
            .route("/mcp", post(handle_post))
            .route("/mcp", get(method_not_allowed))
            .route("/mcp", delete(method_not_allowed))
            .layer(DefaultBodyLimit::max(MAX_MCP_BODY_BYTES))
            .with_state(ServerState {
                authorization,
                expected_host: address.to_string(),
            });
        if let Err(e) = axum::serve(listener, app).await {
            tracing::error!(error = %e, "team MCP server stopped");
        }
    });
}

fn bind_loopback() -> Option<TcpListener> {
    TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).ok()
}

/// std → tokio listener。**必须先 `set_nonblocking(true)`**（tokio 文档要
/// 求）：阻塞 socket 注册进 IOCP 后 accept 永远不完成 —— 症状是 TCP 能连
/// 上（内核 backlog）但 server 永不响应。
fn to_tokio_listener(listener: TcpListener) -> std::io::Result<tokio::net::TcpListener> {
    listener.set_nonblocking(true)?;
    tokio::net::TcpListener::from_std(listener)
}

/// MCP endpoint URL（server 已启动才有值）。`new_session` 传参与
/// `persist_registration` 用；None = server 未启动，跳过注入。
pub fn server_url() -> Option<String> {
    BOUND_PORT
        .get()
        .map(|p| format!("http://127.0.0.1:{p}/mcp"))
}

/// Header value used by the in-process Runtime MCP client.
pub fn authorization_header() -> Option<String> {
    PROCESS_TOKEN.get().map(|token| format!("Bearer {token}"))
}

async fn method_not_allowed() -> Response {
    // MCP streamable-http: 服务端不支持的服务（GET 流 / DELETE 会话）返回
    // 405，client（rmcp）会按规范降级为纯 POST 模式。
    StatusCode::METHOD_NOT_ALLOWED.into_response()
}

// ---------- JSON-RPC 处理 ----------

#[derive(Deserialize)]
struct JsonRpcRequest {
    id: Option<serde_json::Value>,
    method: String,
    #[serde(default)]
    params: serde_json::Value,
}

fn bounded_text(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…（内容已截断）", &value[..end])
}

fn validate_rpc_id(id: &serde_json::Value) -> Result<(), String> {
    match id {
        serde_json::Value::Number(_) => Ok(()),
        serde_json::Value::String(value)
            if value.len() <= MAX_RPC_ID_STRING_BYTES && !value.chars().any(char::is_control) =>
        {
            Ok(())
        }
        _ => Err("JSON-RPC id 必须是有界字符串或数字".into()),
    }
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

fn validate_request_headers(headers: &HeaderMap, state: &ServerState) -> Result<(), StatusCode> {
    let authorization = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if !constant_time_eq(authorization.as_bytes(), state.authorization.as_bytes()) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .ok_or(StatusCode::BAD_REQUEST)?;
    if !host.eq_ignore_ascii_case(&state.expected_host) {
        return Err(StatusCode::MISDIRECTED_REQUEST);
    }

    // The Runtime client is native and never supplies Origin. Rejecting every
    // browser-originated request closes simple cross-origin loopback CSRF.
    if headers.contains_key(header::ORIGIN) {
        return Err(StatusCode::FORBIDDEN);
    }

    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .unwrap_or_default();
    if !content_type.eq_ignore_ascii_case("application/json") {
        return Err(StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }
    Ok(())
}

async fn handle_post(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    if let Err(status) = validate_request_headers(&headers, &state) {
        return status.into_response();
    }
    if body.len() > MAX_MCP_BODY_BYTES {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    let req: JsonRpcRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => return rpc_error(serde_json::Value::Null, -32700, format!("parse error: {e}")),
    };
    if req.method.is_empty()
        || req.method.len() > MAX_RPC_METHOD_BYTES
        || req.method.chars().any(char::is_control)
    {
        return rpc_error(
            serde_json::Value::Null,
            -32600,
            "invalid or oversized JSON-RPC method".into(),
        );
    }
    // 通知（无 id）：202 Accepted，无响应体。
    let Some(id) = req.id else {
        if req.method != "notifications/initialized" {
            tracing::debug!(method = %req.method, "team MCP: ignored notification");
        }
        return StatusCode::ACCEPTED.into_response();
    };
    if let Err(error) = validate_rpc_id(&id) {
        return rpc_error(serde_json::Value::Null, -32600, error);
    }
    let result = match req.method.as_str() {
        "initialize" => match initialize_result(&req.params) {
            Ok(value) => value,
            Err(error) => return rpc_error(id, -32602, error),
        },
        "ping" => serde_json::json!({}),
        "tools/list" => tools_list_result(),
        "tools/call" => match tools_call(&req.params).await {
            Ok(v) => v,
            Err(user_msg) => return rpc_result(id, tool_error_result(&user_msg)),
        },
        other => {
            return rpc_error(id, -32601, format!("method not found: {other}"));
        }
    };
    rpc_result(id, result)
}

fn initialize_result(params: &serde_json::Value) -> Result<serde_json::Value, String> {
    // 回显 client 请求的协议版本（MCP 规范：server 回一个自己支持的版本，
    // 回显 client 版本 = 接受）。client 未带则用 2025-03-26。
    let requested = params
        .get("protocolVersion")
        .and_then(|v| v.as_str())
        .unwrap_or("2025-03-26");
    if requested.is_empty() || requested.len() > 64 || requested.chars().any(char::is_control) {
        return Err("protocolVersion 无效或过长".into());
    }
    CLIENT_INITIALIZED.store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(serde_json::json!({
        "protocolVersion": requested,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": {
            "name": MCP_SERVER_NAME,
            "version": env!("CARGO_PKG_VERSION"),
        },
    }))
}

fn rpc_result(id: serde_json::Value, result: serde_json::Value) -> Response {
    let body = serde_json::json!({ "jsonrpc": "2.0", "id": id.clone(), "result": result });
    let mut text = body.to_string();
    if text.len() > MAX_RPC_RESPONSE_BYTES {
        text = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32603, "message": "response exceeds the configured size limit" }
        })
        .to_string();
    }
    (
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        text,
    )
        .into_response()
}

fn rpc_error(id: serde_json::Value, code: i64, message: String) -> Response {
    let message = bounded_text(&message, MAX_TOOL_ERROR_TEXT_BYTES);
    let body = serde_json::json!({
        "jsonrpc": "2.0", "id": id,
        "error": { "code": code, "message": message }
    });
    (
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        body.to_string(),
    )
        .into_response()
}

// ---------- 工具定义 ----------

fn tools_list_result() -> serde_json::Value {
    serde_json::json!({
        "tools": [
            tool_def("create_team", CREATE_TEAM_DESC, schema_for::<CreateTeamInput>()),
            tool_def("team_status", TEAM_STATUS_DESC, schema_for::<TeamStatusInput>()),
            tool_def("team_delete", TEAM_DELETE_DESC, schema_for::<TeamDeleteInput>()),
        ]
    })
}

fn tool_def(name: &str, description: &str, schema: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "name": name, "description": description, "inputSchema": schema })
}

const CREATE_TEAM_DESC: &str = "Create an expert team. Each member's agent .md must already exist in ~/.echo-agent/agents/. After creation, call the task tool with subagent_type set to a member name (exact, case-sensitive).";
const TEAM_STATUS_DESC: &str =
    "Check the status of agent teams. Returns registered team members and their agent file paths.";
const TEAM_DELETE_DESC: &str =
    "Disband an agent team. Unregisters team members. Optionally deletes their agent .md files.";

fn schema_for<T: JsonSchema>() -> serde_json::Value {
    let schema = schemars::schema_for!(T);
    serde_json::to_value(&schema).unwrap_or_else(|_| serde_json::json!({ "type": "object" }))
}

/// MCP 工具调用结果：成功与用户级失败都走 result（`isError` 区分），
/// JSON-RPC error 只用于协议层错误 —— 这是 MCP 规范约定。
fn tool_text_result(output: &impl Serialize) -> serde_json::Value {
    let text = match serde_json::to_string(output) {
        Ok(text) if text.len() <= MAX_TOOL_OUTPUT_TEXT_BYTES => text,
        Ok(_) => {
            return tool_error_result("工具输出超过 256KB 上限；请指定 team_id 缩小查询范围");
        }
        Err(_) => return tool_error_result("工具输出序列化失败"),
    };
    serde_json::json!({
        "content": [{ "type": "text", "text": text }],
        "isError": false,
    })
}

fn tool_error_result(message: &str) -> serde_json::Value {
    let message = bounded_text(message, MAX_TOOL_ERROR_TEXT_BYTES);
    serde_json::json!({
        "content": [{ "type": "text", "text": message }],
        "isError": true,
    })
}

// ---------- 工具实现（自 team_tools.rs 移植，逻辑不变）----------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateTeamInput {
    #[schemars(description = "Unique team identifier (e.g. 'trading-team')")]
    pub team_id: String,
    #[schemars(
        description = "Team members. Each member's agent .md must already exist in ~/.echo-agent/agents/."
    )]
    pub members: Vec<CreateTeamMember>,
    #[schemars(description = "Optional team description")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateTeamMember {
    #[schemars(
        description = "Agent name; must match an existing ~/.echo-agent/agents/<name>.md (case-sensitive)"
    )]
    pub name: String,
    #[schemars(description = "Member role, e.g. 'code reviewer'")]
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateTeamOutput {
    pub team_id: String,
    pub registered_members: Vec<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TeamStatusInput {
    #[schemars(description = "Team ID. If omitted, lists all active teams.")]
    pub team_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamStatusOutput {
    pub teams: Vec<TeamInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TeamDeleteInput {
    #[schemars(description = "Team ID to disband")]
    pub team_id: String,
    #[schemars(description = "If true, also delete member agent .md files. Default: false.")]
    pub delete_files: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamDeleteOutput {
    pub team_id: String,
    pub message: String,
}

async fn tools_call(params: &serde_json::Value) -> Result<serde_json::Value, String> {
    let params = params
        .as_object()
        .ok_or_else(|| "tools/call params 必须是对象".to_string())?;
    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "tools/call 缺少字符串 name".to_string())?;
    if name.is_empty() || name.len() > 64 || name.chars().any(char::is_control) {
        return Err("工具名无效或过长".into());
    }
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or(serde_json::json!({}));
    if !args.is_object() {
        return Err("工具 arguments 必须是对象".into());
    }
    let argument_size = serde_json::to_vec(&args)
        .map_err(|error| format!("无法校验工具参数：{error}"))?
        .len();
    if argument_size > MAX_TOOL_ARGUMENT_BYTES {
        return Err("工具参数超过 128KB 上限".into());
    }
    match name {
        "create_team" => {
            let input: CreateTeamInput = parse_args(&args)?;
            let out = create_team(input)?;
            Ok(tool_text_result(&out))
        }
        "team_status" => {
            let input: TeamStatusInput = parse_args(&args)?;
            let out = team_status(input)?;
            Ok(tool_text_result(&out))
        }
        "team_delete" => {
            let input: TeamDeleteInput = parse_args(&args)?;
            let out = team_delete(input)?;
            Ok(tool_text_result(&out))
        }
        other => Err(format!("unknown tool: {other}")),
    }
}

fn parse_args<T: DeserializeOwned>(args: &serde_json::Value) -> Result<T, String> {
    let size = serde_json::to_vec(args)
        .map_err(|error| format!("invalid arguments for tool: {error}"))?
        .len();
    if size > MAX_TOOL_ARGUMENT_BYTES {
        return Err("工具参数超过 128KB 上限".into());
    }
    serde_json::from_value(args.clone()).map_err(|e| format!("invalid arguments for tool: {e}"))
}

fn canonical_agents_directory(agents_dir: &Path) -> Result<Option<PathBuf>, String> {
    let metadata = match std::fs::symlink_metadata(agents_dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("检查 agents 目录失败：{error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("agents 目录必须是真实目录，不能是符号链接".into());
    }
    agents_dir
        .canonicalize()
        .map(Some)
        .map_err(|error| format!("解析 agents 目录失败：{error}"))
}

fn create_team(input: CreateTeamInput) -> Result<CreateTeamOutput, String> {
    let agents_dir = crate::agents_store::user_agents_dir_pub();
    let team_id = normalized_team_id(&input.team_id)?;
    if input.members.is_empty() || input.members.len() > MAX_TEAM_MEMBERS {
        return Err(format!("团队成员数必须为 1–{MAX_TEAM_MEMBERS}"));
    }
    if input.description.as_ref().is_some_and(|description| {
        description.chars().count() > MAX_TEAM_DESCRIPTION_CHARS
            || description.len() > MAX_TEAM_DESCRIPTION_BYTES
            || description.contains('\0')
    }) {
        return Err(format!(
            "团队说明不能超过 {MAX_TEAM_DESCRIPTION_CHARS} 个字符且不能包含 NUL"
        ));
    }
    // 去重 + 校验成员名，避免 LLM 误传带路径分隔符/后缀的名字（会写出 agent 目录外）。
    let mut seen = std::collections::HashSet::new();
    for member in &input.members {
        let name = normalized_member_name(&member.name)?;
        if member.role.chars().count() > MAX_MEMBER_ROLE_CHARS
            || member.role.len() > MAX_MEMBER_ROLE_BYTES
            || member.role.chars().any(char::is_control)
        {
            return Err(format!(
                "成员 '{}' 的角色说明不能超过 {MAX_MEMBER_ROLE_CHARS} 个非控制字符",
                name
            ));
        }
        if !seen.insert(name.clone()) {
            return Err(format!("成员名 '{}' 重复出现，每个成员只能出现一次", name));
        }
    }

    let canonical_agents_dir = canonical_agents_directory(&agents_dir)?;
    let mut registered = Vec::new();
    let mut team_members = Vec::new();
    for member in &input.members {
        let name = normalized_member_name(&member.name)?;
        let display_file = agents_dir.join(format!("{}.md", name));
        let agent_file = canonical_agents_dir
            .as_ref()
            .map(|root| root.join(format!("{}.md", name)));
        let metadata = match agent_file.as_ref() {
            Some(path) => match std::fs::symlink_metadata(path) {
                Ok(metadata) => Some(metadata),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => {
                    return Err(format!("检查成员 '{}' 的 agent 文件失败：{error}", name));
                }
            },
            None => None,
        };
        if metadata
            .as_ref()
            .is_some_and(|metadata| !metadata.file_type().is_symlink() && metadata.is_file())
        {
            let agent_file = agent_file.expect("checked above");
            registered.push(name.clone());
            team_members.push(TeamMember {
                name,
                file: agent_file.to_string_lossy().to_string(),
            });
        } else if metadata.is_some_and(|metadata| metadata.file_type().is_symlink()) {
            return Err(format!(
                "拒绝使用符号链接 agent 文件：{}",
                display_file.display()
            ));
        } else if agent_file.as_ref().is_some_and(|path| path.exists()) {
            return Err(format!(
                "agent 定义必须是普通 .md 文件：{}",
                display_file.display()
            ));
        } else {
            // 成员名不匹配是团队功能最常见的报错来源：列出目录里实际存在的
            // agent 文件，并给出目录路径，让 LLM / 用户能立刻看到可选成员。
            let available = list_available_agents(&agents_dir);
            let hint = if available.is_empty() {
                format!(
                    "目录 {} 下还没有任何 agent 定义文件（*.md）。请先在该目录创建成员的 .md 文件。",
                    agents_dir.display()
                )
            } else {
                format!(
                    "可用成员: {}。请确认名称完全匹配（区分大小写）。目录: {}",
                    available.join(", "),
                    agents_dir.display()
                )
            };
            return Err(format!(
                "成员 '{}' 的 agent 文件不存在: {}。\n{}",
                name,
                display_file.display(),
                hint
            ));
        }
    }
    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    update_teams(|teams| {
        if !teams.contains_key(&team_id) && teams.len() >= MAX_TEAMS {
            return Err(format!("团队数量已达 {MAX_TEAMS} 个上限"));
        }
        teams.insert(
            team_id.clone(),
            TeamInfo {
                team_id: team_id.clone(),
                members: team_members,
                created_at,
            },
        );
        Ok(())
    })?;
    // 成功消息里强调：成员名必须与 task 工具的 subagent_type 完全一致，
    // 否则 EchoAgent 会返回 "Unknown subagent type"。
    Ok(CreateTeamOutput {
        team_id: team_id.clone(),
        message: format!(
            "团队 '{}' 已创建，{} 名成员已就绪: {}。\n\
             用法: 调用 task 工具时，subagent_type 参数必须填写成员名（完全一致，区分大小写），\
             例如 {{\"subagent_type\": \"{}\", \"prompt\": \"...\"}}。",
            team_id,
            registered.len(),
            registered.join(", "),
            registered.first().cloned().unwrap_or_default()
        ),
        registered_members: registered,
    })
}

fn team_status(input: TeamStatusInput) -> Result<TeamStatusOutput, String> {
    let requested_id = input
        .team_id
        .as_deref()
        .map(normalized_team_id)
        .transpose()?;
    let teams = read_teams_from_disk()?;
    let result = match requested_id {
        Some(id) => match teams.get(&id) {
            Some(t) => vec![t.clone()],
            None => return Err(format!("团队 '{}' 不存在", id)),
        },
        None => {
            let mut values = teams.values().cloned().collect::<Vec<_>>();
            values.sort_by(|a, b| {
                b.created_at
                    .cmp(&a.created_at)
                    .then_with(|| a.team_id.cmp(&b.team_id))
            });
            values
        }
    };
    Ok(TeamStatusOutput { teams: result })
}

fn team_delete(input: TeamDeleteInput) -> Result<TeamDeleteOutput, String> {
    let team_id = normalized_team_id(&input.team_id)?;
    let delete_files = input.delete_files.unwrap_or(false);
    // Resolve and validate every stored member path before mutating the team
    // registry. A hand-edited/corrupt team store must never turn this MCP tool
    // into an arbitrary file-delete primitive.
    let files_to_delete = update_teams(|teams| {
        let team = teams
            .get(&team_id)
            .ok_or_else(|| format!("团队 '{}' 不存在", team_id))?
            .clone();
        let mut files = Vec::new();
        if delete_files {
            let agents_dir = crate::agents_store::user_agents_dir_pub();
            for member in &team.members {
                if let Some(file) = validated_agent_file_for_delete_at(&agents_dir, member)? {
                    files.push(file);
                }
            }
        }
        teams.remove(&team_id);
        Ok(files)
    })?;
    let mut deleted_count = 0;
    let mut failed_count = 0;
    if delete_files {
        for file in files_to_delete {
            match remove_validated_agent_file(&file) {
                Ok(true) => deleted_count += 1,
                Ok(false) => {}
                Err(error) => {
                    failed_count += 1;
                    tracing::warn!(path = %file.path.display(), %error, "failed to delete team member agent file");
                }
            }
        }
    }
    let message = if delete_files {
        format!(
            "团队 '{}' 已解散，{} 个成员 agent 文件已删除，{} 个删除失败。",
            team_id, deleted_count, failed_count
        )
    } else {
        format!("团队 '{}' 已解散（成员 agent 文件保留）。", team_id)
    };
    Ok(TeamDeleteOutput { team_id, message })
}

#[derive(Debug)]
struct ValidatedAgentFile {
    path: PathBuf,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

fn validated_agent_file_for_delete_at(
    agents_dir: &Path,
    member: &TeamMember,
) -> Result<Option<ValidatedAgentFile>, String> {
    let name = normalized_member_name(&member.name)?;
    if name != member.name {
        return Err("拒绝删除名称未规范化的 agent 文件".into());
    }
    let expected_name = format!("{name}.md");
    let path = PathBuf::from(&member.file);
    if path.file_name().and_then(|value| value.to_str()) != Some(expected_name.as_str()) {
        return Err(format!(
            "拒绝删除与成员名不匹配的 agent 文件：{}",
            path.display()
        ));
    }
    let raw_expected = agents_dir.join(&expected_name);
    let canonical_root = canonical_agents_directory(agents_dir)?;
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if path != raw_expected
                && canonical_root
                    .as_ref()
                    .is_none_or(|root| path != root.join(&expected_name))
            {
                return Err(format!("拒绝处理 agents 目录外的文件：{}", path.display()));
            }
            return Ok(None);
        }
        Err(error) => return Err(format!("无法校验 agent 文件 {}: {error}", path.display())),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("拒绝删除非普通 agent 文件：{}", path.display()));
    }
    let agents_root = canonical_root.ok_or_else(|| "agents 目录不存在".to_string())?;
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("无法解析 agent 文件 {}: {error}", path.display()))?;
    if canonical.parent() != Some(agents_root.as_path())
        || canonical.file_name().and_then(|value| value.to_str()) != Some(expected_name.as_str())
    {
        return Err(format!(
            "拒绝删除 agents 目录外的文件：{}",
            canonical.display()
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(Some(ValidatedAgentFile {
            path: canonical,
            device: metadata.dev(),
            inode: metadata.ino(),
        }))
    }
    #[cfg(not(unix))]
    {
        Ok(Some(ValidatedAgentFile { path: canonical }))
    }
}

fn remove_validated_agent_file(file: &ValidatedAgentFile) -> Result<bool, String> {
    let metadata = match std::fs::symlink_metadata(&file.path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("重新检查 agent 文件失败：{error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("拒绝删除在确认后被替换的非普通 agent 文件".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.dev() != file.device || metadata.ino() != file.inode {
            return Err("拒绝删除在确认后被替换的 agent 文件".into());
        }
    }
    std::fs::remove_file(&file.path)
        .map(|_| true)
        .map_err(|error| format!("删除 agent 文件失败：{error}"))
}

/// 列出 agents 目录里实际存在的 `*.md` agent 定义文件名（去后缀）。
/// 用于 `create_team` 报错时给 LLM / 用户展示可选项。
fn list_available_agents(agents_dir: &Path) -> Vec<String> {
    let mut names = Vec::new();
    if let Ok(entries) = std::fs::read_dir(agents_dir) {
        for entry in entries.take(MAX_AVAILABLE_AGENT_SCAN_ENTRIES).flatten() {
            let path = entry.path();
            let is_regular_file = std::fs::symlink_metadata(&path)
                .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink());
            if is_regular_file && path.extension().and_then(|e| e.to_str()) == Some("md") {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    if normalized_member_name(stem).as_deref() == Ok(stem) {
                        names.push(stem.to_string());
                    }
                }
            }
            if names.len() >= MAX_AVAILABLE_AGENT_NAMES {
                break;
            }
        }
    }
    names.sort();
    names
}

// ---------- 持久化注册（config.toml，经 EchoAgent 的 echo.agent/mcp/upsert）----------

/// 进程级守卫：upsert 幂等且便宜，但每次会话都发一遍 ACP 往返没
/// 必要 —— config.toml 里的条目跨重启存在，但每次进程的端口和令牌都会轮换。失败时复位，
/// 下个会话可重试（比如 upsert 时会话恰好刚关闭）。
static PERSISTED: Mutex<bool> = Mutex::new(false);

/// 把 echoagent MCP server 写进 EchoAgent 的 config.toml（经 `echo.agent/mcp/upsert`，
/// EchoAgent 自己持久化 —— 避免我们直接改写用户 config.toml 丢注释/格式）。
/// 需要一个**已存在**的会话（EchoAgent 的 upsert handler 要求 session live）。
/// 失败只 warn：new_session 传参路径仍然生效，只是 load_session 的旧会话
/// 拿不到工具。
pub fn persist_registration(tx: &xai_acp_lib::AcpAgentTx, session_id: &str) {
    {
        let mut done = PERSISTED.lock().unwrap();
        if *done {
            return;
        }
        *done = true; // 先占位防并发重入；失败时下面复位
    }
    let (Some(url), Some(authorization)) = (server_url(), authorization_header()) else {
        *PERSISTED.lock().unwrap() = false;
        return;
    };
    let tx = tx.clone();
    let session_id = session_id.to_string();
    tokio::spawn(async move {
        // payload 形状同 mcp.rs build_upsert_payload（wire key 为 snake_case）。
        let payload = serde_json::json!({
            "session_id": session_id,
            "server_name": MCP_SERVER_NAME,
            "url": url,
            "headers": { AUTH_HEADER: authorization },
            "enabled": true,
        });
        match crate::ext::call_ext_value(
            &tx,
            "echo.agent/mcp/upsert",
            crate::ext::raw_params(&payload),
        )
        .await
        {
            Ok(_) => tracing::info!("team MCP server persisted to config.toml"),
            Err(e) => {
                tracing::warn!(error = ?e, "team MCP persist_registration failed (new_session param path still active)");
                // 允许下个会话重试（比如 upsert 时会话恰好刚关闭）。
                *PERSISTED.lock().unwrap() = false;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_team(store_path: &Path, id: &str) -> TeamInfo {
        TeamInfo {
            team_id: id.to_string(),
            members: vec![TeamMember {
                name: id.to_string(),
                file: store_path
                    .parent()
                    .unwrap()
                    .join(format!("{id}.md"))
                    .to_string_lossy()
                    .to_string(),
            }],
            created_at: 1,
        }
    }

    /// JSON Schema 健全性：三个工具的 inputSchema 都必须是 object 类型且
    /// 带 properties —— MCP client（rmcp）会把它直接下发给模型。
    #[test]
    fn tool_schemas_are_sane() {
        for (name, schema) in [
            ("create_team", schema_for::<CreateTeamInput>()),
            ("team_status", schema_for::<TeamStatusInput>()),
            ("team_delete", schema_for::<TeamDeleteInput>()),
        ] {
            assert_eq!(schema["type"], "object", "{name}: schema type");
            assert!(
                schema
                    .get("properties")
                    .is_some_and(|p| p.as_object().is_some_and(|o| !o.is_empty())),
                "{name}: schema properties"
            );
        }
    }

    /// create_team 的成员名校验：路径分隔符 / `..` / `.md` 后缀 / 重复名。
    #[test]
    fn create_team_rejects_bad_member_names() {
        for bad in ["a/b", "a\\b", "..", "a.md", ""] {
            let input = CreateTeamInput {
                team_id: "t".into(),
                members: vec![CreateTeamMember {
                    name: bad.into(),
                    role: "r".into(),
                }],
                description: None,
            };
            assert!(create_team(input).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn team_store_rejects_unsafe_shapes_and_bounds_tool_data() {
        let directory = tempfile::tempdir().unwrap();
        let store = directory.path().join("teams.json");
        let mut teams = HashMap::new();
        let mut team = test_team(&store, "alpha");
        team.team_id = "different".into();
        teams.insert("alpha".into(), team);
        assert!(validate_team_store(&teams).is_err());

        let oversized = "x".repeat(MAX_TOOL_OUTPUT_TEXT_BYTES + 1);
        assert_eq!(tool_text_result(&oversized)["isError"], true);
        let oversized_args = serde_json::json!({
            "team_id": "x".repeat(MAX_TOOL_ARGUMENT_BYTES + 1)
        });
        assert!(parse_args::<TeamStatusInput>(&oversized_args).is_err());
        assert!(parse_args::<TeamStatusInput>(&serde_json::json!({
            "unexpected": true
        }))
        .is_err());
    }

    #[test]
    fn corrupt_team_store_is_quarantined_and_reported() {
        let directory = tempfile::tempdir().unwrap();
        let store = directory.path().join("teams.json");
        std::fs::write(&store, b"{not-json").unwrap();

        let error = with_team_store_access_at(&store, || load_teams_from_disk_at(&store))
            .expect_err("corrupt store must not become an empty writable store");
        assert!(error.contains("已隔离至"), "{error}");
        assert!(!store.exists());
        let backups = std::fs::read_dir(directory.path())
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("teams.json.corrupt.")
            })
            .count();
        assert_eq!(backups, 1);
    }

    #[cfg(unix)]
    #[test]
    fn team_store_and_delete_reject_symlinks_and_outside_paths() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target.json");
        std::fs::write(&target, b"{}").unwrap();
        let linked_store = directory.path().join("teams.json");
        symlink(&target, &linked_store).unwrap();
        assert!(load_teams_from_disk_at(&linked_store).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"{}");

        let agents = directory.path().join("agents");
        std::fs::create_dir(&agents).unwrap();
        let outside = directory.path().join("alice.md");
        std::fs::write(&outside, b"safe").unwrap();
        let member = TeamMember {
            name: "alice".into(),
            file: outside.to_string_lossy().to_string(),
        };
        assert!(validated_agent_file_for_delete_at(&agents, &member).is_err());

        let real = agents.join("real.md");
        std::fs::write(&real, b"safe").unwrap();
        let linked = agents.join("alice.md");
        symlink(&real, &linked).unwrap();
        let member = TeamMember {
            name: "alice".into(),
            file: linked.to_string_lossy().to_string(),
        };
        assert!(validated_agent_file_for_delete_at(&agents, &member).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn delete_rejects_file_replaced_after_validation() {
        let directory = tempfile::tempdir().unwrap();
        let agents = directory.path().join("agents");
        std::fs::create_dir(&agents).unwrap();
        let path = agents.join("alice.md");
        std::fs::write(&path, b"original").unwrap();
        let member = TeamMember {
            name: "alice".into(),
            file: path.to_string_lossy().to_string(),
        };
        let validated = validated_agent_file_for_delete_at(&agents, &member)
            .unwrap()
            .unwrap();
        let replacement = directory.path().join("replacement.md");
        std::fs::write(&replacement, b"replacement").unwrap();
        std::fs::rename(&replacement, &path).unwrap();
        assert!(remove_validated_agent_file(&validated).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"replacement");

        let bob_path = agents.join("bob.md");
        std::fs::write(&bob_path, b"ordinary").unwrap();
        let bob = TeamMember {
            name: "bob".into(),
            file: bob_path.to_string_lossy().to_string(),
        };
        let validated = validated_agent_file_for_delete_at(&agents, &bob)
            .unwrap()
            .unwrap();
        assert!(remove_validated_agent_file(&validated).unwrap());
        assert!(!bob_path.exists());
    }

    #[test]
    fn team_store_thread_transactions_do_not_lose_updates() {
        let directory = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(directory.path().join("teams.json"));
        let mut workers = Vec::new();
        for index in 0..16 {
            let store = store.clone();
            workers.push(std::thread::spawn(move || {
                let id = format!("thread-{index}");
                let team = test_team(&store, &id);
                update_teams_at(&store, |teams| {
                    teams.insert(id, team);
                    Ok(())
                })
                .unwrap();
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }
        let teams = with_team_store_access_at(&store, || load_teams_from_disk_at(&store)).unwrap();
        assert_eq!(teams.len(), 16);
    }

    #[test]
    fn team_store_subprocess_writer() {
        let (Some(store), Some(id)) = (
            std::env::var_os("ECHOAGENT_TEAM_TEST_STORE"),
            std::env::var_os("ECHOAGENT_TEAM_TEST_ID"),
        ) else {
            return;
        };
        let store = PathBuf::from(store);
        let id = id.to_string_lossy().to_string();
        let team = test_team(&store, &id);
        update_teams_at(&store, |teams| {
            teams.insert(id, team);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn team_store_process_transactions_do_not_lose_updates() {
        let directory = tempfile::tempdir().unwrap();
        let store = directory.path().join("teams.json");
        let executable = std::env::current_exe().unwrap();
        let mut children = Vec::new();
        for index in 0..4 {
            children.push(
                std::process::Command::new(&executable)
                    .arg("--exact")
                    .arg("team_mcp::tests::team_store_subprocess_writer")
                    .arg("--nocapture")
                    .env("ECHOAGENT_TEAM_TEST_STORE", &store)
                    .env("ECHOAGENT_TEAM_TEST_ID", format!("process-{index}"))
                    .spawn()
                    .unwrap(),
            );
        }
        for mut child in children {
            assert!(child.wait().unwrap().success());
        }
        let teams = with_team_store_access_at(&store, || load_teams_from_disk_at(&store)).unwrap();
        assert_eq!(teams.len(), 4);
    }

    /// 端到端（无 EchoAgent）：真起一个 server，用 reqwest 走完 MCP 握手 +
    /// tools/list + tools/call。这是 MCP 协议层的回归防线 —— EchoAgent 的
    /// rmcp client 若连不上/解析失败，会表现为工具静默消失。
    /// （顺带守住 `from_std` 忘设 non-blocking 的坑 —— 那会让 accept 永远
    /// 不完成，表现为 TCP 能连但无响应。）
    #[tokio::test]
    async fn mcp_http_handshake_list_call() {
        // 独立实例，不与生产端口/全局状态纠缠：随机端口 + 专用 listener。
        let std_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = std_listener.local_addr().unwrap();
        let listener = to_tokio_listener(std_listener).unwrap();
        let authorization = "Bearer test-only-secret";
        let server_state = ServerState {
            authorization: authorization.into(),
            expected_host: addr.to_string(),
        };
        tokio::spawn(async move {
            let app = Router::new()
                .route("/mcp", post(handle_post))
                .route("/mcp", get(method_not_allowed))
                .route("/mcp", delete(method_not_allowed))
                .layer(DefaultBodyLimit::max(MAX_MCP_BODY_BYTES))
                .with_state(server_state);
            let _ = axum::serve(listener, app).await;
        });

        let client = reqwest::Client::new();
        let url = format!("http://{addr}/mcp");

        // initialize
        let init = serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-06-18", "capabilities": {},
                        "clientInfo": { "name": "test", "version": "0" } }
        });
        let status = client.post(&url).json(&init).send().await.unwrap().status();
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        let status = client
            .post(&url)
            .header(header::AUTHORIZATION, authorization)
            .header(header::ORIGIN, "https://attacker.invalid")
            .json(&init)
            .send()
            .await
            .unwrap()
            .status();
        assert_eq!(status, StatusCode::FORBIDDEN);

        let status = client
            .post(&url)
            .header(header::AUTHORIZATION, authorization)
            .body(init.to_string())
            .send()
            .await
            .unwrap()
            .status();
        assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);

        let resp: serde_json::Value = client
            .post(&url)
            .header(header::AUTHORIZATION, authorization)
            .json(&init)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(resp["result"]["protocolVersion"], "2025-06-18");
        assert!(resp["result"]["capabilities"]["tools"].is_object());

        // notification → 202
        let notif = serde_json::json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        let status = client
            .post(&url)
            .header(header::AUTHORIZATION, authorization)
            .json(&notif)
            .send()
            .await
            .unwrap()
            .status();
        assert_eq!(status, 202);

        // tools/list
        let list = serde_json::json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" });
        let resp: serde_json::Value = client
            .post(&url)
            .header(header::AUTHORIZATION, authorization)
            .json(&list)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let names: Vec<&str> = resp["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["create_team", "team_status", "team_delete"]);

        // tools/call: 参数校验失败会通过工具级 isError 返回，
        // 不会泄漏成 JSON-RPC 协议错误。使用无效 ID 避免测试读取用户真实状态。
        let call = serde_json::json!({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "team_status", "arguments": { "team_id": "\u{0}" } }
        });
        let resp: serde_json::Value = client
            .post(&url)
            .header(header::AUTHORIZATION, authorization)
            .json(&call)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(resp["result"]["isError"], true);

        // 未知工具 → 工具级错误（isError: true），不是协议错误
        let call = serde_json::json!({
            "jsonrpc": "2.0", "id": 4, "method": "tools/call",
            "params": { "name": "nope", "arguments": {} }
        });
        let resp: serde_json::Value = client
            .post(&url)
            .header(header::AUTHORIZATION, authorization)
            .json(&call)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(resp["result"]["isError"], true);

        // GET → 405（无服务端推流）
        let status = client.get(&url).send().await.unwrap().status();
        assert_eq!(status, 405);
    }

    #[test]
    fn team_server_binds_an_ephemeral_loopback_port() {
        let listener = bind_loopback().expect("bind loopback");
        let address = listener.local_addr().unwrap();
        assert!(address.ip().is_loopback());
        assert_ne!(address.port(), 0);
    }
}
