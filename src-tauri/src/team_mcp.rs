//! EchoAgent 内嵌 MCP server —— 团队工具的非侵入式实现。
//!
//! 之前 `create_team` / `team_status` / `team_delete` 通过 grok 补丁
//! (`patches/grok-build/02-team-tools-enabled-set.patch`) 注入 grok 的默认
//! 启用集。本模块改为**标准 MCP streamable-http server**（仅监听
//! 127.0.0.1），grok 作为 MCP client 连接，工具以 `echoagent__create_team`
//! 等名字出现 —— 对 grok 零侵入，升级 grok-build 不再需要运行时补丁。
//!
//! 注册路径（双保险）：
//!  1. `grok::new_session` 时通过 ACP `mcp_servers` 参数传入 —— 会话立即可用
//!     （merge 层中 client 层优先级最高，见 grok `managed_mcp.rs`）。
//!  2. 首个会话建立后调用 `x.ai/mcp/upsert` 持久化到 config.toml（grok 自己
//!     写盘）—— `load_session` 恢复的会话也能用（grok 会话启动时从
//!     config.toml 加载 MCP server 列表）。
//!
//! 状态：团队数据持久化到 `~/.grok/echoagent-teams.json`，应用/agent 重启
//! 不丢（旧实现里 TEAMS 在 grok 进程内存中，agent 崩溃重启即丢）。
//!
//! MCP 协议子集（streamable HTTP, MCP 2025-03-26 / 2025-06-18 兼容）：
//!   POST /mcp  — JSON-RPC: initialize / ping / tools/list / tools/call；
//!                 通知（无 id）返回 202。
//!   GET  /mcp  — 405（服务端不主动推流，规范允许）。
//!   DELETE /mcp — 405（无会话状态可删）。

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Router,
};
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::sync::{LazyLock, Mutex, OnceLock};

// ---------- 团队状态（进程级 + 磁盘持久化）----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamInfo {
    pub team_id: String,
    pub members: Vec<TeamMember>,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamMember {
    pub name: String,
    pub file: String,
}

static TEAMS: LazyLock<Mutex<HashMap<String, TeamInfo>>> = LazyLock::new(|| {
    let teams = load_teams_from_disk().unwrap_or_default();
    Mutex::new(teams)
});

/// `~/.grok/echoagent-teams.json` —— 与 grok 配置同目录，方便用户备份。
fn teams_file() -> std::path::PathBuf {
    crate::grok::grok_home_dir().join("echoagent-teams.json")
}

fn load_teams_from_disk() -> Option<HashMap<String, TeamInfo>> {
    let path = teams_file();
    let text = std::fs::read_to_string(&path).ok()?;
    match serde_json::from_str(&text) {
        Ok(map) => Some(map),
        Err(e) => {
            tracing::warn!(path = %path.display(), error = %e, "team store corrupt — starting empty");
            None
        }
    }
}

fn save_teams_to_disk(teams: &HashMap<String, TeamInfo>) {
    let path = teams_file();
    match serde_json::to_string_pretty(teams) {
        Ok(text) => {
            if let Err(e) = std::fs::write(&path, text) {
                tracing::warn!(path = %path.display(), error = %e, "failed to persist teams");
            }
        }
        Err(e) => tracing::warn!(error = %e, "failed to serialize teams"),
    }
}

// ---------- server 生命周期 ----------

/// 首选端口。优先固定端口（常见情形下 config.toml 里的 URL 跨重启不失效），
/// 被占用则向后扫描至 +20，全被占则报错（极端场景，重启应用即可）。
pub const MCP_PREFERRED_PORT: u16 = 14730;
const MCP_PORT_SCAN: u16 = 20;
pub const MCP_SERVER_NAME: &str = "echoagent";

static BOUND_PORT: OnceLock<u16> = OnceLock::new();

/// grok 的 MCP client 是否已完成 initialize 握手（诊断/测试用）。
static CLIENT_INITIALIZED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// 诊断：grok（或测试）是否已连上并完成 MCP initialize。
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
    let Some(listener) = bind_with_retry() else {
        tracing::error!("team MCP server: no free port in 14730..=14750 — team tools unavailable");
        return;
    };
    let port = listener
        .local_addr()
        .map(|a| a.port())
        .unwrap_or(MCP_PREFERRED_PORT);
    let _ = BOUND_PORT.set(port);
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
            .with_state(());
        if let Err(e) = axum::serve(listener, app).await {
            tracing::error!(error = %e, "team MCP server stopped");
        }
    });
}

fn bind_with_retry() -> Option<TcpListener> {
    for offset in 0..=MCP_PORT_SCAN {
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, MCP_PREFERRED_PORT + offset));
        if let Ok(l) = TcpListener::bind(addr) {
            return Some(l);
        }
    }
    None
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

async fn handle_post(State(_): State<()>, body: axum::body::Bytes) -> Response {
    let req: JsonRpcRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => return rpc_error(serde_json::Value::Null, -32700, format!("parse error: {e}")),
    };
    // 通知（无 id）：202 Accepted，无响应体。
    let Some(id) = req.id else {
        if req.method != "notifications/initialized" {
            tracing::debug!(method = %req.method, "team MCP: ignored notification");
        }
        return StatusCode::ACCEPTED.into_response();
    };
    let result = match req.method.as_str() {
        "initialize" => initialize_result(&req.params),
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

fn initialize_result(params: &serde_json::Value) -> serde_json::Value {
    CLIENT_INITIALIZED.store(true, std::sync::atomic::Ordering::SeqCst);
    // 回显 client 请求的协议版本（MCP 规范：server 回一个自己支持的版本，
    // 回显 client 版本 = 接受）。client 未带则用 2025-03-26。
    let requested = params
        .get("protocolVersion")
        .and_then(|v| v.as_str())
        .unwrap_or("2025-03-26");
    serde_json::json!({
        "protocolVersion": requested,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": {
            "name": MCP_SERVER_NAME,
            "version": env!("CARGO_PKG_VERSION"),
        },
    })
}

fn rpc_result(id: serde_json::Value, result: serde_json::Value) -> Response {
    let body = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result });
    (
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        body.to_string(),
    )
        .into_response()
}

fn rpc_error(id: serde_json::Value, code: i64, message: String) -> Response {
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

const CREATE_TEAM_DESC: &str = "Create an expert team. Each member's agent .md must already exist in ~/.grok/agents/. After creation, call the task tool with subagent_type set to a member name (exact, case-sensitive).";
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
    let text = serde_json::to_string(output).unwrap_or_else(|_| "{}".into());
    serde_json::json!({
        "content": [{ "type": "text", "text": text }],
        "isError": false,
    })
}

fn tool_error_result(message: &str) -> serde_json::Value {
    serde_json::json!({
        "content": [{ "type": "text", "text": message }],
        "isError": true,
    })
}

// ---------- 工具实现（自 team_tools.rs 移植，逻辑不变）----------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CreateTeamInput {
    #[schemars(description = "Unique team identifier (e.g. 'trading-team')")]
    pub team_id: String,
    #[schemars(
        description = "Team members. Each member's agent .md must already exist in ~/.grok/agents/."
    )]
    pub members: Vec<CreateTeamMember>,
    #[schemars(description = "Optional team description")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CreateTeamMember {
    #[schemars(
        description = "Agent name; must match an existing ~/.grok/agents/<name>.md (case-sensitive)"
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
pub struct TeamStatusInput {
    #[schemars(description = "Team ID. If omitted, lists all active teams.")]
    pub team_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamStatusOutput {
    pub teams: Vec<TeamInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
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
    let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or(serde_json::json!({}));
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
    serde_json::from_value(args.clone()).map_err(|e| format!("invalid arguments for tool: {e}"))
}

fn create_team(input: CreateTeamInput) -> Result<CreateTeamOutput, String> {
    let agents_dir = crate::agents_store::user_agents_dir_pub();
    // 去重 + 校验成员名，避免 LLM 误传带路径分隔符/后缀的名字（会写出 agent 目录外）。
    let mut seen = std::collections::HashSet::new();
    for member in &input.members {
        let name = member.name.trim();
        if name.is_empty() {
            return Err("成员名不能为空".to_string());
        }
        if name.contains('/')
            || name.contains('\\')
            || name.contains("..")
            || name.contains('\0')
            || name.ends_with(".md")
        {
            return Err(format!(
                "成员名 '{}' 非法：不能包含路径分隔符、'..' 或 '.md' 后缀（请只用纯名称）",
                name
            ));
        }
        if !seen.insert(name.to_string()) {
            return Err(format!("成员名 '{}' 重复出现，每个成员只能出现一次", name));
        }
    }

    let mut registered = Vec::new();
    let mut team_members = Vec::new();
    for member in &input.members {
        let name = member.name.trim();
        let agent_file = agents_dir.join(format!("{}.md", name));
        if agent_file.is_file() {
            registered.push(name.to_string());
            team_members.push(TeamMember {
                name: name.to_string(),
                file: agent_file.to_string_lossy().to_string(),
            });
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
                agent_file.display(),
                hint
            ));
        }
    }
    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    {
        let mut teams = TEAMS.lock().unwrap();
        teams.insert(
            input.team_id.clone(),
            TeamInfo {
                team_id: input.team_id.clone(),
                members: team_members,
                created_at,
            },
        );
        save_teams_to_disk(&teams);
    }
    // 成功消息里强调：成员名必须与 task 工具的 subagent_type 完全一致，
    // 否则 grok 会返回 "Unknown subagent type"。
    Ok(CreateTeamOutput {
        team_id: input.team_id.clone(),
        message: format!(
            "团队 '{}' 已创建，{} 名成员已就绪: {}。\n\
             用法: 调用 task 工具时，subagent_type 参数必须填写成员名（完全一致，区分大小写），\
             例如 {{\"subagent_type\": \"{}\", \"prompt\": \"...\"}}。",
            input.team_id,
            registered.len(),
            registered.join(", "),
            registered.first().cloned().unwrap_or_default()
        ),
        registered_members: registered,
    })
}

fn team_status(input: TeamStatusInput) -> Result<TeamStatusOutput, String> {
    let teams = TEAMS.lock().unwrap();
    let result = match input.team_id {
        Some(id) => match teams.get(&id) {
            Some(t) => vec![t.clone()],
            None => return Err(format!("团队 '{}' 不存在", id)),
        },
        None => teams.values().cloned().collect(),
    };
    Ok(TeamStatusOutput { teams: result })
}

fn team_delete(input: TeamDeleteInput) -> Result<TeamDeleteOutput, String> {
    let delete_files = input.delete_files.unwrap_or(false);
    let removed = {
        let mut teams = TEAMS.lock().unwrap();
        let team = teams
            .remove(&input.team_id)
            .ok_or_else(|| format!("团队 '{}' 不存在", input.team_id))?;
        save_teams_to_disk(&teams);
        team
    };
    let mut deleted_count = 0;
    if delete_files {
        for member in &removed.members {
            let path = std::path::PathBuf::from(&member.file);
            if path.is_file() && std::fs::remove_file(&path).is_ok() {
                deleted_count += 1;
            }
        }
    }
    let message = if delete_files {
        format!(
            "团队 '{}' 已解散，{} 个成员 agent 文件已删除。",
            input.team_id, deleted_count
        )
    } else {
        format!("团队 '{}' 已解散（成员 agent 文件保留）。", input.team_id)
    };
    Ok(TeamDeleteOutput {
        team_id: input.team_id,
        message,
    })
}

/// 列出 agents 目录里实际存在的 `*.md` agent 定义文件名（去后缀）。
/// 用于 `create_team` 报错时给 LLM / 用户展示可选项。
fn list_available_agents(agents_dir: &std::path::Path) -> Vec<String> {
    let mut names = Vec::new();
    if let Ok(entries) = std::fs::read_dir(agents_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("md") {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    names.push(stem.to_string());
                }
            }
        }
    }
    names.sort();
    names
}

// ---------- 持久化注册（config.toml，经 grok 的 x.ai/mcp/upsert）----------

/// 进程级守卫：upsert 幂等且便宜，但每次会话都发一遍 ACP 往返没
/// 必要 —— config.toml 里的条目跨重启存在，端口通常也稳定。失败时复位，
/// 下个会话可重试（比如 upsert 时会话恰好刚关闭）。
static PERSISTED: Mutex<bool> = Mutex::new(false);

/// 把 echoagent MCP server 写进 grok 的 config.toml（经 `x.ai/mcp/upsert`，
/// grok 自己持久化 —— 避免我们直接改写用户 config.toml 丢注释/格式）。
/// 需要一个**已存在**的会话（grok 的 upsert handler 要求 session live）。
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
    let Some(url) = server_url() else { return };
    let tx = tx.clone();
    let session_id = session_id.to_string();
    tokio::spawn(async move {
        // payload 形状同 mcp.rs build_upsert_payload（wire key 为 snake_case）。
        let payload = serde_json::json!({
            "session_id": session_id,
            "server_name": MCP_SERVER_NAME,
            "url": url,
            "enabled": true,
        });
        match crate::ext::call_ext_value(&tx, "x.ai/mcp/upsert", crate::ext::raw_params(&payload))
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

    /// 端到端（无 grok）：真起一个 server，用 reqwest 走完 MCP 握手 +
    /// tools/list + tools/call。这是 MCP 协议层的回归防线 —— grok 的
    /// rmcp client 若连不上/解析失败，会表现为工具静默消失。
    /// 端到端（无 grok）：真起一个 server，用 reqwest 走完 MCP 握手 +
    /// tools/list + tools/call。这是 MCP 协议层的回归防线 —— grok 的
    /// rmcp client 若连不上/解析失败，会表现为工具静默消失。
    /// （顺带守住 `from_std` 忘设 non-blocking 的坑 —— 那会让 accept 永远
    /// 不完成，表现为 TCP 能连但无响应。）
    #[tokio::test]
    async fn mcp_http_handshake_list_call() {
        // 独立实例，不与生产端口/全局状态纠缠：随机端口 + 专用 listener。
        let std_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = std_listener.local_addr().unwrap();
        let listener = to_tokio_listener(std_listener).unwrap();
        tokio::spawn(async move {
            let app = Router::new()
                .route("/mcp", post(handle_post))
                .route("/mcp", get(method_not_allowed))
                .route("/mcp", delete(method_not_allowed))
                .with_state(());
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
        let resp: serde_json::Value = client
            .post(&url)
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

        // tools/call: team_status（空列表也是成功 —— 工具级错误走 isError）
        let call = serde_json::json!({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "team_status", "arguments": {} }
        });
        let resp: serde_json::Value = client
            .post(&url)
            .json(&call)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(resp["result"]["isError"], false);

        // 未知工具 → 工具级错误（isError: true），不是协议错误
        let call = serde_json::json!({
            "jsonrpc": "2.0", "id": 4, "method": "tools/call",
            "params": { "name": "nope", "arguments": {} }
        });
        let resp: serde_json::Value = client
            .post(&url)
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
}
