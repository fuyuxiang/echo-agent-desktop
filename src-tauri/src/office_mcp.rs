//! Built-in, task-scoped document creation for the embedded Agent Runtime.
//! The model supplies content and format; the destination comes from the
//! authoritative session workspace, never from an LLM-supplied path.

use axum::{
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};

pub const MCP_SERVER_NAME: &str = "echoagent-office";
pub const SESSION_HEADER: &str = "X-EchoAgent-Session-Id";
const BODY_LIMIT: usize = 5 * 1024 * 1024;
static SERVICE: OnceLock<Arc<Service>> = OnceLock::new();
static PERSISTED: Mutex<bool> = Mutex::new(false);

struct Service {
    port: u16,
    token: String,
    ready: AtomicBool,
}

#[derive(Clone)]
struct ServerState {
    app: AppHandle,
    authorization: String,
    expected_host: String,
}

#[derive(Deserialize)]
struct RpcRequest {
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

pub fn serve(app: AppHandle) -> Result<(), String> {
    if SERVICE.get().is_some() {
        return Ok(());
    }
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .map_err(|error| format!("办公文档服务无法绑定本地端口：{error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let service = Arc::new(Service {
        port,
        token: uuid::Uuid::now_v7().to_string(),
        ready: AtomicBool::new(false),
    });
    let state = ServerState {
        app,
        authorization: format!("Bearer {}", service.token),
        expected_host: format!("127.0.0.1:{port}"),
    };
    SERVICE
        .set(service.clone())
        .map_err(|_| "办公文档服务重复启动".to_string())?;
    let (startup_tx, startup_rx) = std::sync::mpsc::channel();
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(error) => {
                service.ready.store(false, Ordering::Release);
                tracing::error!(%error, "office MCP listener failed");
                let _ = startup_tx.send(Err(format!("办公文档服务启动失败：{error}")));
                return;
            }
        };
        let router = Router::new()
            .route("/mcp", post(handle_post))
            .layer(DefaultBodyLimit::max(BODY_LIMIT))
            .with_state(state);
        service.ready.store(true, Ordering::Release);
        let _ = startup_tx.send(Ok(()));
        if let Err(error) = axum::serve(listener, router).await {
            tracing::error!(%error, "office MCP server stopped");
        }
        service.ready.store(false, Ordering::Release);
        *PERSISTED.lock().unwrap() = false;
    });
    startup_rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|error| format!("等待办公文档服务启动超时：{error}"))?
}

pub fn server_url() -> Option<String> {
    SERVICE.get().and_then(|service| {
        service
            .ready
            .load(Ordering::Acquire)
            .then(|| format!("http://127.0.0.1:{}/mcp", service.port))
    })
}

pub fn authorization_header() -> Option<String> {
    SERVICE.get().and_then(|service| {
        service
            .ready
            .load(Ordering::Acquire)
            .then(|| format!("Bearer {}", service.token))
    })
}

fn valid_headers(headers: &HeaderMap, state: &ServerState) -> Result<String, StatusCode> {
    let auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;
    // The secret is generated for this process, so comparison is constant time.
    if auth.len() != state.authorization.len()
        || auth
            .as_bytes()
            .iter()
            .zip(state.authorization.as_bytes())
            .fold(0u8, |difference, (left, right)| difference | (left ^ right))
            != 0
    {
        return Err(StatusCode::UNAUTHORIZED);
    }
    if headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        != Some(state.expected_host.as_str())
    {
        return Err(StatusCode::MISDIRECTED_REQUEST);
    }
    if headers.contains_key(header::ORIGIN) {
        return Err(StatusCode::FORBIDDEN);
    }
    if !headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.split(';').next() == Some("application/json"))
    {
        return Err(StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }
    let session_id = headers
        .get(SESSION_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if session_id.is_empty() || session_id.len() > 256 || session_id.chars().any(char::is_control) {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(session_id.to_string())
}

async fn handle_post(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let session_id = match valid_headers(&headers, &state) {
        Ok(session_id) => session_id,
        Err(status) => return status.into_response(),
    };
    if body.len() > BODY_LIMIT {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    let request: RpcRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(error) => return rpc_error(Value::Null, -32700, format!("invalid JSON: {error}")),
    };
    let Some(id) = request.id else {
        return StatusCode::ACCEPTED.into_response();
    };
    if !matches!(id, Value::String(_) | Value::Number(_)) {
        return rpc_error(Value::Null, -32600, "invalid JSON-RPC id".into());
    }
    let result = match request.method.as_str() {
        "initialize" => json!({
            "protocolVersion": request.params.get("protocolVersion").and_then(Value::as_str).unwrap_or("2025-03-26"),
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": MCP_SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
        }),
        "ping" => json!({}),
        "tools/list" => json!({ "tools": [{
            "name": "office_create",
            "description": "Create a real Word (.docx), PDF, Excel (.xlsx), or PowerPoint (.pptx) file from Markdown in this task's authorized workspace. For spreadsheet output, use Markdown tables. Returns the exact saved path and SHA-256. Use this when the user requests a deliverable document; no account, external converter, or setup is needed.",
            "inputSchema": {
                "type": "object", "additionalProperties": false,
                "properties": {
                    "title": { "type": "string", "maxLength": 160 },
                    "markdown": { "type": "string", "maxLength": 2097152 },
                    "format": { "type": "string", "enum": ["docx", "pdf", "xlsx", "pptx"] }
                },
                "required": ["title", "markdown", "format"]
            }
        }] }),
        "tools/call" => match call_tool(&state.app, &session_id, &request.params).await {
            Ok(receipt) => json!({ "content": [{ "type": "text", "text": receipt.to_string() }] }),
            Err(error) => {
                json!({ "content": [{ "type": "text", "text": error }], "isError": true })
            }
        },
        other => return rpc_error(id, -32601, format!("unknown method: {other}")),
    };
    rpc_result(id, result)
}

async fn call_tool(app: &AppHandle, session_id: &str, params: &Value) -> Result<Value, String> {
    if params.get("name").and_then(Value::as_str) != Some("office_create") {
        return Err("未知的办公文档工具".into());
    }
    let request: crate::document_export::DocumentExportRequest =
        serde_json::from_value(params.get("arguments").cloned().ok_or("缺少文档参数")?)
            .map_err(|error| format!("文档参数无效：{error}"))?;
    crate::document_export::validate_request(&request)?;
    // Use the live native session binding. Historical listings are capped and
    // can omit an older task even while it is open in the desktop.
    let session_cwd = app
        .state::<crate::commands::AppState>()
        .session_workspace(session_id)?;
    let access = app.state::<crate::shell_fs::FilesystemAccess>();
    let workspace = access.require_workspace(&session_cwd.to_string_lossy())?;
    let directory = workspace.join("EchoAgent成果");
    std::fs::create_dir_all(&directory).map_err(|error| format!("无法创建成果目录：{error}"))?;
    let metadata = std::fs::symlink_metadata(&directory).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("成果目录不是普通目录".into());
    }
    let canonical = directory
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !canonical.starts_with(&workspace) {
        return Err("成果目录不在当前工作区".into());
    }
    let filename = format!(
        "{}-{}.{}",
        crate::document_export::safe_file_title(&request.title),
        uuid::Uuid::now_v7().simple(),
        request.format,
    );
    let destination = canonical.join(filename);
    if Path::new(&destination).exists() {
        return Err("生成的文档路径已存在，请重试".into());
    }
    let receipt = crate::document_export::export_to_path(app, request, &destination).await?;
    serde_json::to_value(receipt).map_err(|error| error.to_string())
}

fn rpc_result(id: Value, result: Value) -> Response {
    (
        [(header::CONTENT_TYPE, "application/json")],
        json!({"jsonrpc":"2.0","id":id,"result":result}).to_string(),
    )
        .into_response()
}

fn rpc_error(id: Value, code: i64, message: String) -> Response {
    (
        [(header::CONTENT_TYPE, "application/json")],
        json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}}).to_string(),
    )
        .into_response()
}

pub fn persist_registration(tx: &echo_agent_acp::AcpAgentTx, session_id: &str) {
    {
        let mut persisted = PERSISTED.lock().unwrap();
        if *persisted {
            return;
        }
        *persisted = true;
    }
    let (Some(url), Some(authorization)) = (server_url(), authorization_header()) else {
        *PERSISTED.lock().unwrap() = false;
        return;
    };
    let tx = tx.clone();
    let session_id = session_id.to_string();
    tauri::async_runtime::spawn(async move {
        let payload = json!({
            "session_id": session_id,
            "server_name": MCP_SERVER_NAME,
            "url": url,
            "headers": {
                "Authorization": authorization,
                (SESSION_HEADER): "${session_id}"
            },
            "enabled": true,
        });
        if let Err(error) = crate::ext::call_ext_value(
            &tx,
            "echo.agent/mcp/upsert",
            crate::ext::raw_params(&payload),
        )
        .await
        {
            tracing::warn!(?error, "office MCP registration failed");
            *PERSISTED.lock().unwrap() = false;
        }
    });
}
