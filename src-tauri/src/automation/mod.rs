//! Built-in Browser Use and Computer Use service.
//!
//! The embedded Runtime already consumes MCP and expands `${session_id}` in
//! HTTP headers. This module uses that trusted session binding rather than an
//! LLM-supplied argument, so automation state cannot cross task boundaries.

mod browser;
mod computer;

use axum::{
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Router,
};
use browser::BrowserController;
use computer::ComputerController;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

pub const MCP_SERVER_NAME: &str = "echoagent-automation";
pub const AUTH_HEADER: &str = "Authorization";
pub const SESSION_HEADER: &str = "X-EchoAgent-Session-Id";
const MAX_MCP_BODY_BYTES: usize = 256 * 1024;
const MAX_RPC_RESPONSE_BYTES: usize = 24 * 1024 * 1024;
const MAX_TOOL_ARGUMENT_BYTES: usize = 128 * 1024;
const MAX_SESSION_ID_CHARS: usize = 256;
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(5 * 60);

static BOUND_PORT: OnceLock<u16> = OnceLock::new();
static PROCESS_TOKEN: OnceLock<String> = OnceLock::new();
static MANAGER: OnceLock<Arc<AutomationManager>> = OnceLock::new();
static PERSISTED: Mutex<bool> = Mutex::new(false);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomationMode {
    Default,
    BrowserUse,
    ComputerUse,
}

impl AutomationMode {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "default" | "agent" => Ok(Self::Default),
            "browser_use" | "browser" => Ok(Self::BrowserUse),
            "computer_use" | "computer" => Ok(Self::ComputerUse),
            _ => Err(format!("unsupported automation mode: {value}")),
        }
    }

    fn allows_browser(self) -> bool {
        matches!(self, Self::BrowserUse)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationStatus {
    pub session_id: String,
    pub mode: AutomationMode,
    pub paused: bool,
    pub allow_private_network: bool,
    pub browser: browser::BrowserCapability,
    pub computer: computer::ComputerCapability,
    pub browser_running: bool,
    pub browser_url: Option<String>,
    pub browser_title: Option<String>,
}

struct AutomationSession {
    mode: Mutex<AutomationMode>,
    paused: Mutex<bool>,
    allow_private_network: Mutex<bool>,
    browser: AsyncMutex<Option<BrowserController>>,
    computer: Mutex<ComputerController>,
}

impl AutomationSession {
    fn new(mode: AutomationMode) -> Self {
        Self {
            mode: Mutex::new(mode),
            paused: Mutex::new(false),
            allow_private_network: Mutex::new(false),
            browser: AsyncMutex::new(None),
            computer: Mutex::new(ComputerController::default()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationApproval {
    pub request_id: String,
    pub session_id: String,
    pub tool: String,
    pub title: String,
    pub description: String,
    pub details: Value,
}

struct PendingApproval {
    request: AutomationApproval,
    response: oneshot::Sender<bool>,
}

struct AutomationManager {
    app: AppHandle,
    sessions: AsyncMutex<HashMap<String, Arc<AutomationSession>>>,
    approvals: AsyncMutex<HashMap<String, PendingApproval>>,
}

impl AutomationManager {
    fn new(app: AppHandle) -> Self {
        Self {
            app,
            sessions: AsyncMutex::new(HashMap::new()),
            approvals: AsyncMutex::new(HashMap::new()),
        }
    }

    async fn session(&self, session_id: &str) -> Result<Arc<AutomationSession>, String> {
        validate_session_id(session_id)?;
        let mut sessions = self.sessions.lock().await;
        Ok(sessions
            .entry(session_id.to_string())
            .or_insert_with(|| {
                let mode = crate::meta::agent_mode(session_id)
                    .as_deref()
                    .and_then(|mode| AutomationMode::parse(mode).ok())
                    .unwrap_or(AutomationMode::Default);
                Arc::new(AutomationSession::new(mode))
            })
            .clone())
    }

    async fn set_mode(&self, session_id: &str, mode: AutomationMode) -> Result<(), String> {
        let session = self.session(session_id).await?;
        *session.mode.lock().unwrap() = mode;
        *session.paused.lock().unwrap() = false;
        if !mode.allows_browser() {
            if let Some(mut browser) = session.browser.lock().await.take() {
                let _ = browser.stop().await;
            }
        }
        self.reject_session_approvals(session_id).await;
        self.emit_status(session_id).await;
        Ok(())
    }

    async fn status(&self, session_id: &str) -> Result<AutomationStatus, String> {
        let session = self.session(session_id).await?;
        let mode = *session.mode.lock().unwrap();
        let paused = *session.paused.lock().unwrap();
        let allow_private_network = *session.allow_private_network.lock().unwrap();
        let mut browser_guard = session.browser.lock().await;
        let browser_status = match browser_guard.as_mut() {
            Some(browser) => browser.status().await.ok(),
            None => None,
        };
        Ok(AutomationStatus {
            session_id: session_id.to_string(),
            mode,
            paused,
            allow_private_network,
            browser: browser::capability(),
            computer: ComputerController::capability(),
            browser_running: browser_status.as_ref().is_some_and(|status| status.running),
            browser_url: browser_status
                .as_ref()
                .and_then(|status| status.url.clone()),
            browser_title: browser_status.and_then(|status| status.title),
        })
    }

    async fn emit_status(&self, session_id: &str) {
        if let Ok(status) = self.status(session_id).await {
            let _ = self.app.emit("automation://status", status);
        }
    }

    async fn ensure_active(
        &self,
        session_id: &str,
        required: AutomationMode,
    ) -> Result<Arc<AutomationSession>, String> {
        let session = self.session(session_id).await?;
        if *session.mode.lock().unwrap() != required {
            return Err(match required {
                AutomationMode::BrowserUse => {
                    "当前任务未启用 Browser Use，请先切换到浏览器模式".into()
                }
                AutomationMode::ComputerUse => {
                    "当前任务未启用 Computer Use，请先切换到电脑模式".into()
                }
                AutomationMode::Default => "当前任务模式不允许此操作".into(),
            });
        }
        if *session.paused.lock().unwrap() {
            return Err("自动化已暂停。用户接管期间不会执行任何浏览器或电脑操作。".into());
        }
        Ok(session)
    }

    async fn pause(&self, session_id: &str, paused: bool) -> Result<(), String> {
        let session = self.session(session_id).await?;
        *session.paused.lock().unwrap() = paused;
        if paused {
            // Taking over is a hard boundary: no earlier approval request may
            // remain live and resume an operation behind the user's back.
            self.reject_session_approvals(session_id).await;
        }
        self.emit_status(session_id).await;
        Ok(())
    }

    async fn stop(&self, session_id: &str) -> Result<(), String> {
        let session = self.session(session_id).await?;
        *session.paused.lock().unwrap() = true;
        let browser_result = if let Some(mut browser) = session.browser.lock().await.take() {
            browser.stop().await
        } else {
            Ok(())
        };
        self.reject_session_approvals(session_id).await;
        self.emit_status(session_id).await;
        browser_result
    }

    async fn reject_session_approvals(&self, session_id: &str) {
        let mut approvals = self.approvals.lock().await;
        let request_ids = approvals
            .iter()
            .filter_map(|(id, pending)| {
                (pending.request.session_id == session_id).then_some(id.clone())
            })
            .collect::<Vec<_>>();
        for request_id in request_ids {
            if let Some(pending) = approvals.remove(&request_id) {
                let _ = pending.response.send(false);
                let _ = self.app.emit(
                    "automation://approval-closed",
                    json!({ "requestId": request_id, "sessionId": session_id }),
                );
            }
        }
    }

    async fn set_private_network(&self, session_id: &str, allowed: bool) -> Result<(), String> {
        let session = self.session(session_id).await?;
        *session.allow_private_network.lock().unwrap() = allowed;
        if let Some(browser) = session.browser.lock().await.as_mut() {
            browser.set_allow_private_network(allowed);
            if !allowed {
                // If the user revokes access while a private page is open,
                // leave it immediately instead of waiting for the next tool.
                let _ = browser.enforce_current_url_policy().await;
            }
        }
        self.emit_status(session_id).await;
        Ok(())
    }

    async fn approve(
        &self,
        session_id: &str,
        tool: &str,
        title: &str,
        description: &str,
        details: Value,
    ) -> Result<(), String> {
        let request_id = uuid::Uuid::now_v7().to_string();
        let request = AutomationApproval {
            request_id: request_id.clone(),
            session_id: session_id.to_string(),
            tool: tool.to_string(),
            title: title.to_string(),
            description: description.to_string(),
            details,
        };
        let (tx, rx) = oneshot::channel();
        self.approvals.lock().await.insert(
            request_id.clone(),
            PendingApproval {
                request: request.clone(),
                response: tx,
            },
        );
        if self.app.emit("automation://approval", &request).is_err() {
            self.approvals.lock().await.remove(&request_id);
            return Err("无法显示自动化安全确认，操作已取消".into());
        }
        match tokio::time::timeout(APPROVAL_TIMEOUT, rx).await {
            Ok(Ok(true)) => Ok(()),
            Ok(Ok(false)) => Err("用户拒绝了该高风险自动化操作".into()),
            Ok(Err(_)) => Err("自动化安全确认已关闭，操作未执行".into()),
            Err(_) => {
                self.approvals.lock().await.remove(&request_id);
                Err("自动化安全确认等待超时，操作未执行".into())
            }
        }
    }

    async fn shutdown_all(&self) {
        let sessions = self
            .sessions
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for session in sessions {
            if let Some(mut browser) = session.browser.lock().await.take() {
                let _ = browser.stop().await;
            }
        }
        let pending = std::mem::take(&mut *self.approvals.lock().await);
        for (_, approval) in pending {
            let _ = approval.response.send(false);
        }
    }

    async fn forget_session(&self, session_id: &str) {
        if let Some(session) = self.sessions.lock().await.remove(session_id) {
            if let Some(mut browser) = session.browser.lock().await.take() {
                let _ = browser.stop().await;
            }
        }
        self.reject_session_approvals(session_id).await;
        if let Err(error) = browser::remove_profile(session_id).await {
            tracing::warn!(%error, %session_id, "failed to remove deleted task browser profile");
        }
    }
}

fn manager() -> Result<&'static Arc<AutomationManager>, String> {
    MANAGER
        .get()
        .ok_or_else(|| "自动化服务尚未启动".to_string())
}

pub fn serve(app: AppHandle) {
    if MANAGER.get().is_some() {
        return;
    }
    let Some(listener) = bind_loopback() else {
        tracing::error!("automation MCP: failed to bind loopback socket");
        return;
    };
    let port = match listener.local_addr() {
        Ok(address) => address.port(),
        Err(error) => {
            tracing::error!(%error, "automation MCP: failed to read bound address");
            return;
        }
    };
    let token = uuid::Uuid::now_v7().to_string();
    let authorization = format!("Bearer {token}");
    let automation = Arc::new(AutomationManager::new(app));
    if MANAGER.set(automation.clone()).is_err()
        || BOUND_PORT.set(port).is_err()
        || PROCESS_TOKEN.set(token).is_err()
    {
        tracing::error!("automation MCP: process state was initialized twice");
        return;
    }
    let listener = match to_tokio_listener(listener) {
        Ok(listener) => listener,
        Err(error) => {
            tracing::error!(%error, "automation MCP: failed to register listener");
            return;
        }
    };
    tauri::async_runtime::spawn(async move {
        let expected_host = format!("127.0.0.1:{port}");
        let router = Router::new()
            .route(
                "/mcp",
                post(handle_post)
                    .get(method_not_allowed)
                    .delete(method_not_allowed),
            )
            .layer(DefaultBodyLimit::max(MAX_MCP_BODY_BYTES))
            .with_state(ServerState {
                authorization,
                expected_host,
                manager: automation,
            });
        if let Err(error) = axum::serve(listener, router).await {
            tracing::error!(%error, "automation MCP server stopped");
        }
    });
    tracing::info!(port, "automation MCP server listening");
}

fn bind_loopback() -> Option<TcpListener> {
    TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).ok()
}

fn to_tokio_listener(listener: TcpListener) -> std::io::Result<tokio::net::TcpListener> {
    listener.set_nonblocking(true)?;
    tokio::net::TcpListener::from_std(listener)
}

pub fn server_url() -> Option<String> {
    BOUND_PORT
        .get()
        .map(|port| format!("http://127.0.0.1:{port}/mcp"))
}

pub fn authorization_header() -> Option<String> {
    PROCESS_TOKEN.get().map(|token| format!("Bearer {token}"))
}

pub async fn set_session_mode(session_id: &str, mode: AutomationMode) -> Result<(), String> {
    validate_mode_capability(mode)?;
    manager()?.set_mode(session_id, mode).await
}

pub fn validate_mode_capability(mode: AutomationMode) -> Result<(), String> {
    match mode {
        AutomationMode::Default => Ok(()),
        AutomationMode::BrowserUse => {
            let capability = browser::capability();
            if capability.available {
                Ok(())
            } else {
                Err(capability
                    .reason
                    .unwrap_or_else(|| "Browser Use 当前不可用".into()))
            }
        }
        AutomationMode::ComputerUse => {
            let capability = ComputerController::capability();
            if capability.available {
                Ok(())
            } else {
                Err(capability
                    .reason
                    .unwrap_or_else(|| "Computer Use 当前不可用".into()))
            }
        }
    }
}

pub async fn forget_session(session_id: &str) {
    if let Some(manager) = MANAGER.get() {
        manager.forget_session(session_id).await;
    }
}

pub async fn pause_session(session_id: &str) -> Result<(), String> {
    manager()?.pause(session_id, true).await
}

pub async fn stop_session(session_id: &str) -> Result<(), String> {
    manager()?.stop(session_id).await
}

pub async fn shutdown_all() {
    if let Some(manager) = MANAGER.get() {
        manager.shutdown_all().await;
    }
}

#[tauri::command]
pub async fn automation_status(session_id: String) -> Result<AutomationStatus, String> {
    manager()?.status(&session_id).await
}

#[tauri::command]
pub async fn automation_pause(session_id: String) -> Result<AutomationStatus, String> {
    manager()?.pause(&session_id, true).await?;
    manager()?.status(&session_id).await
}

#[tauri::command]
pub async fn automation_resume(session_id: String) -> Result<AutomationStatus, String> {
    manager()?.pause(&session_id, false).await?;
    manager()?.status(&session_id).await
}

#[tauri::command]
pub async fn automation_stop(session_id: String) -> Result<AutomationStatus, String> {
    manager()?.stop(&session_id).await?;
    manager()?.status(&session_id).await
}

#[tauri::command]
pub async fn automation_set_private_network(
    session_id: String,
    allowed: bool,
) -> Result<AutomationStatus, String> {
    if allowed {
        manager()?
            .approve(
                &session_id,
                "automation_set_private_network",
                "允许访问本机和内网",
                "受控浏览器将可以访问环回地址、局域网和企业内网。网页可能接触本机服务，请确认当前任务确实需要此权限。",
                json!({ "allowed": true }),
            )
            .await?;
    }
    manager()?.set_private_network(&session_id, allowed).await?;
    manager()?.status(&session_id).await
}

#[tauri::command]
pub fn automation_request_computer_permissions() -> Result<computer::ComputerCapability, String> {
    ComputerController::request_permissions()
}

#[tauri::command]
pub async fn automation_pending_approvals(
    session_id: Option<String>,
) -> Result<Vec<AutomationApproval>, String> {
    let approvals = manager()?.approvals.lock().await;
    Ok(approvals
        .values()
        .filter(|pending| {
            session_id
                .as_deref()
                .is_none_or(|session_id| pending.request.session_id == session_id)
        })
        .map(|pending| pending.request.clone())
        .collect())
}

#[tauri::command]
pub async fn automation_resolve_approval(
    request_id: String,
    approved: bool,
) -> Result<bool, String> {
    let pending = manager()?.approvals.lock().await.remove(&request_id);
    let Some(pending) = pending else {
        return Ok(false);
    };
    let _ = pending.response.send(approved);
    let _ = manager()?.app.emit(
        "automation://approval-closed",
        json!({ "requestId": request_id, "sessionId": pending.request.session_id }),
    );
    Ok(true)
}

#[derive(Clone)]
struct ServerState {
    authorization: String,
    expected_host: String,
    manager: Arc<AutomationManager>,
}

#[derive(Deserialize)]
struct JsonRpcRequest {
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

async fn method_not_allowed() -> Response {
    StatusCode::METHOD_NOT_ALLOWED.into_response()
}

async fn handle_post(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let session_id = match validate_headers(&headers, &state) {
        Ok(session_id) => session_id,
        Err(status) => return status.into_response(),
    };
    if body.len() > MAX_MCP_BODY_BYTES {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    let request: JsonRpcRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(error) => return rpc_error(Value::Null, -32700, format!("parse error: {error}")),
    };
    let Some(id) = request.id else {
        return StatusCode::ACCEPTED.into_response();
    };
    if !matches!(id, Value::String(_) | Value::Number(_)) {
        return rpc_error(Value::Null, -32600, "invalid JSON-RPC id".into());
    }
    let result = match request.method.as_str() {
        "initialize" => Ok(initialize_result(&request.params)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(tools_list_result()),
        "tools/call" => tools_call(&state.manager, &session_id, &request.params).await,
        other => return rpc_error(id, -32601, format!("method not found: {other}")),
    };
    match result {
        Ok(result) => rpc_result(id, result),
        Err(error) => rpc_result(id, tool_error_result(&error)),
    }
}

fn validate_headers(headers: &HeaderMap, state: &ServerState) -> Result<String, StatusCode> {
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
    let session_id = headers
        .get(SESSION_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;
    validate_session_id(session_id).map_err(|_| StatusCode::BAD_REQUEST)?;
    Ok(session_id.to_string())
}

fn initialize_result(params: &Value) -> Value {
    let protocol = params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or("2025-03-26");
    json!({
        "protocolVersion": protocol,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": MCP_SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
    })
}

fn tools_list_result() -> Value {
    json!({ "tools": [
        tool("automation_status", "Read Browser Use and Computer Use capability, mode and lifecycle status for this task.", object_schema(&[])),
        tool("automation_pause", "Pause all browser/computer actions so the user can take over safely.", object_schema(&[])),
        tool("automation_resume", "Resume a paused automation session after the user returns control.", object_schema(&[])),
        tool("automation_stop", "Stop the controlled browser and all automation for this task.", object_schema(&[])),

        tool("browser_start", "Start the task-isolated controlled browser. Call before other browser tools.", object_schema(&[])),
        tool("browser_navigate", "Navigate the controlled browser to an absolute public http/https URL and wait for DOM readiness.", schema(json!({ "url": {"type":"string","maxLength":4096} }), &["url"])),
        tool("browser_snapshot", "Return current page title, URL, readable text and interactive elements with stable element refs.", object_schema(&[])),
        tool("browser_screenshot", "Capture the visible controlled-browser viewport. Returns an image and viewport metadata.", object_schema(&[])),
        tool("browser_click", "Click an element ref from browser_snapshot, or viewport coordinates. Consequential controls require independent user confirmation.", schema(json!({
            "elementRef":{"type":"string","maxLength":128}, "x":{"type":"number"}, "y":{"type":"number"},
            "button":{"type":"string","enum":["left","right","middle"],"default":"left"}, "clickCount":{"type":"integer","minimum":1,"maximum":3,"default":1}
        }), &[])),
        tool("browser_hover", "Move the browser pointer over an element ref.", schema(json!({"elementRef":{"type":"string","maxLength":128}}), &["elementRef"])),
        tool("browser_type", "Focus an input/contenteditable element and type text. Password fields always require user confirmation.", schema(json!({
            "elementRef":{"type":"string","maxLength":128}, "text":{"type":"string","maxLength":65536}, "replace":{"type":"boolean","default":true}
        }), &["elementRef","text"])),
        tool("browser_select", "Select one or more values/text labels in a select element.", schema(json!({
            "elementRef":{"type":"string","maxLength":128}, "values":{"type":"array","minItems":1,"maxItems":100,"items":{"type":"string","maxLength":1024}}
        }), &["elementRef","values"])),
        tool("browser_upload", "Upload workspace files through a file input. This always pauses for user confirmation before any file is disclosed to the website.", schema(json!({
            "elementRef":{"type":"string","maxLength":128}, "paths":{"type":"array","minItems":1,"maxItems":20,"items":{"type":"string","maxLength":4096}}
        }), &["elementRef","paths"])),
        tool("browser_key", "Press one browser key with optional modifiers. Enter/Return may require confirmation when a form is active.", schema(json!({
            "key":{"type":"string","maxLength":64}, "modifiers":{"type":"array","maxItems":4,"items":{"type":"string","enum":["shift","ctrl","control","alt","option","cmd","command","meta"]}}
        }), &["key"])),
        tool("browser_scroll", "Scroll the current browser viewport by pixel deltas.", schema(json!({"deltaX":{"type":"number","default":0},"deltaY":{"type":"number"}}), &["deltaY"])),
        tool("browser_drag", "Drag between two viewport coordinates.", schema(json!({"fromX":{"type":"number"},"fromY":{"type":"number"},"toX":{"type":"number"},"toY":{"type":"number"}}), &["fromX","fromY","toX","toY"])),
        tool("browser_tabs", "List browser tabs or create/select/close one.", schema(json!({
            "action":{"type":"string","enum":["list","new","select","close"],"default":"list"}, "targetId":{"type":"string","maxLength":256}, "url":{"type":"string","maxLength":4096}
        }), &[])),
        tool("browser_wait", "Wait briefly for an asynchronous page update, then return the current URL.", schema(json!({"milliseconds":{"type":"integer","minimum":50,"maximum":30000,"default":1000}}), &[])),
        tool("browser_downloads", "List files downloaded by this task's isolated browser, including completion status and local path.", object_schema(&[])),
        tool("browser_stop", "Stop the controlled browser for this task without changing conversation mode.", object_schema(&[])),

        tool("computer_capabilities", "Check operating-system screen capture and input-control permissions.", object_schema(&[])),
        tool("computer_displays", "List controllable displays and their logical/pixel coordinate systems.", object_schema(&[])),
        tool("computer_screenshot", "Capture a display. Returns a frameId, coordinate metadata and PNG image. Coordinate actions must use this frameId.", schema(json!({"displayId":{"type":"string","maxLength":128}}), &[])),
        tool("computer_move", "Move the pointer using coordinates from a current computer_screenshot frame. Hover UI may change, so the frame is invalidated.", schema(json!({"frameId":{"type":"string"},"x":{"type":"number"},"y":{"type":"number"}}), &["frameId","x","y"])),
        tool("computer_click", "Click using coordinates from a current screenshot. The frame is invalidated after the action.", schema(json!({
            "frameId":{"type":"string"},"x":{"type":"number"},"y":{"type":"number"},"button":{"type":"string","enum":["left","right","middle"],"default":"left"},"clickCount":{"type":"integer","minimum":1,"maximum":3,"default":1},"consequential":{"type":"boolean","default":false},"intent":{"type":"string","maxLength":500}
        }), &["frameId","x","y"])),
        tool("computer_drag", "Drag between two coordinates from a current screenshot and invalidate the frame.", schema(json!({
            "frameId":{"type":"string"},"fromX":{"type":"number"},"fromY":{"type":"number"},"toX":{"type":"number"},"toY":{"type":"number"},"durationMs":{"type":"integer","minimum":100,"maximum":5000,"default":500}
        }), &["frameId","fromX","fromY","toX","toY"])),
        tool("computer_scroll", "Scroll the active desktop target using a current screenshot frame. Positive deltaY scrolls down and the frame is invalidated.", schema(json!({"frameId":{"type":"string"},"deltaX":{"type":"integer","default":0},"deltaY":{"type":"integer"}}), &["frameId","deltaY"])),
        tool("computer_type", "Type text into the focused desktop control. Set sensitive=true for credentials and consequential=true for text that will be published/sent.", schema(json!({
            "frameId":{"type":"string"},"text":{"type":"string","maxLength":65536},"sensitive":{"type":"boolean","default":false},"consequential":{"type":"boolean","default":false},"intent":{"type":"string","maxLength":500}
        }), &["frameId","text"])),
        tool("computer_key", "Press a desktop key with optional modifiers. Consequential shortcuts require confirmation.", schema(json!({
            "frameId":{"type":"string"},"key":{"type":"string","maxLength":64},"modifiers":{"type":"array","maxItems":4,"items":{"type":"string"}},"consequential":{"type":"boolean","default":false},"intent":{"type":"string","maxLength":500}
        }), &["frameId","key"])),
        tool("computer_wait", "Wait briefly before taking the next screenshot.", schema(json!({"milliseconds":{"type":"integer","minimum":50,"maximum":30000,"default":1000}}), &[]))
    ] })
}

fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({ "name": name, "description": description, "inputSchema": input_schema })
}

fn object_schema(required: &[&str]) -> Value {
    schema(json!({}), required)
}

fn schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": properties,
        "required": required,
    })
}

async fn tools_call(
    manager: &Arc<AutomationManager>,
    session_id: &str,
    params: &Value,
) -> Result<Value, String> {
    let object = params
        .as_object()
        .ok_or_else(|| "tools/call params 必须是对象".to_string())?;
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| "tools/call 缺少字符串 name".to_string())?;
    let args = object
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !args.is_object() {
        return Err("工具 arguments 必须是对象".into());
    }
    if serde_json::to_vec(&args)
        .map_err(|error| format!("无法校验工具参数：{error}"))?
        .len()
        > MAX_TOOL_ARGUMENT_BYTES
    {
        return Err("工具参数超过 128KB 上限".into());
    }
    let result = match name {
        "automation_status" => serde_json::to_value(manager.status(session_id).await?)
            .map_err(|error| error.to_string())?,
        "automation_pause" => {
            manager.pause(session_id, true).await?;
            serde_json::to_value(manager.status(session_id).await?)
                .map_err(|error| error.to_string())?
        }
        "automation_resume" => {
            manager.pause(session_id, false).await?;
            serde_json::to_value(manager.status(session_id).await?)
                .map_err(|error| error.to_string())?
        }
        "automation_stop" => {
            manager.stop(session_id).await?;
            serde_json::to_value(manager.status(session_id).await?)
                .map_err(|error| error.to_string())?
        }
        name if name.starts_with("browser_") => {
            return browser_tool(manager, session_id, name, &args).await;
        }
        name if name.starts_with("computer_") => {
            return computer_tool(manager, session_id, name, &args).await;
        }
        other => return Err(format!("unknown tool: {other}")),
    };
    Ok(tool_json_result(result))
}

async fn browser_tool(
    manager: &Arc<AutomationManager>,
    session_id: &str,
    name: &str,
    args: &Value,
) -> Result<Value, String> {
    let session = manager
        .ensure_active(session_id, AutomationMode::BrowserUse)
        .await?;
    if name == "browser_stop" {
        if let Some(mut browser) = session.browser.lock().await.take() {
            browser.stop().await?;
        }
        manager.emit_status(session_id).await;
        return Ok(tool_json_result(json!({ "stopped": true })));
    }
    let launched = {
        let mut guard = session.browser.lock().await;
        let needs_launch = match guard.as_mut() {
            None => true,
            Some(browser) => match browser.status().await {
                Ok(status) => !status.running,
                Err(error) => {
                    tracing::warn!(%error, %session_id, "controlled browser connection was lost; restarting");
                    true
                }
            },
        };
        if needs_launch {
            if let Some(mut browser) = guard.take() {
                let _ = browser.stop().await;
            }
            let allow_private = *session.allow_private_network.lock().unwrap();
            *guard = Some(BrowserController::launch(session_id, allow_private).await?);
            true
        } else {
            false
        }
    };
    if launched {
        manager.emit_status(session_id).await;
    }

    // Never hold the browser mutex while waiting for a human decision. This
    // keeps status/pause/stop responsive throughout the approval window.
    let mut approved_url: Option<String> = None;
    let mut approved_risk: Option<String> = None;
    let mut upload_paths: Vec<String> = Vec::new();
    match name {
        "browser_click" => {
            if let Some(reference) = optional_str(args, "elementRef")? {
                let mut guard = session.browser.lock().await;
                let browser = guard.as_mut().expect("browser inserted above");
                if let Some(reason) = risky_browser_element(browser, reference).await? {
                    approved_url = Some(browser.current_url().await?);
                    approved_risk = Some(reason.clone());
                    drop(guard);
                    manager
                        .approve(
                            session_id,
                            name,
                            "确认网页上的重要操作",
                            &reason,
                            json!({ "elementRef": reference }),
                        )
                        .await?;
                }
            }
        }
        "browser_type" => {
            let reference = required_str(args, "elementRef")?;
            let mut guard = session.browser.lock().await;
            let browser = guard.as_mut().expect("browser inserted above");
            if browser_element_is_password(browser, reference).await? {
                approved_url = Some(browser.current_url().await?);
                drop(guard);
                manager
                    .approve(
                        session_id,
                        name,
                        "确认填写敏感信息",
                        "目标是密码输入框。为保护凭据，本次填写必须由你单独确认。",
                        json!({ "elementRef": reference, "characters": required_str(args, "text")?.chars().count() }),
                    )
                    .await?;
            }
        }
        "browser_key" => {
            let key = required_str(args, "key")?;
            if matches!(key.to_ascii_lowercase().as_str(), "enter" | "return") {
                approved_url = Some(
                    session
                        .browser
                        .lock()
                        .await
                        .as_mut()
                        .expect("browser inserted above")
                        .current_url()
                        .await?,
                );
                manager
                    .approve(
                        session_id,
                        name,
                        "确认提交当前网页内容",
                        "Enter/Return 可能提交表单、发送消息或确认交易，请确认后继续。",
                        json!({ "key": key }),
                    )
                    .await?;
            }
        }
        "browser_upload" => {
            upload_paths = validate_upload_paths(manager, session_id, args)?;
            approved_url = Some(
                session
                    .browser
                    .lock()
                    .await
                    .as_mut()
                    .expect("browser inserted above")
                    .current_url()
                    .await?,
            );
            let names = upload_paths
                .iter()
                .filter_map(|path| std::path::Path::new(path).file_name())
                .map(|name| name.to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            manager
                .approve(
                    session_id,
                    name,
                    "确认向网站上传文件",
                    "文件内容将离开本机并提交给当前网站。仅允许上传当前任务工作区内的普通文件。",
                    json!({ "files": names, "fileCount": upload_paths.len() }),
                )
                .await?;
        }
        _ => {}
    }

    manager
        .ensure_active(session_id, AutomationMode::BrowserUse)
        .await?;
    let mut guard = session.browser.lock().await;
    let browser = guard.as_mut().expect("browser inserted above");
    browser.enforce_current_url_policy().await?;
    if let Some(expected_url) = approved_url {
        if browser.current_url().await? != expected_url {
            return Err("等待确认期间网页已变化，为避免误操作已取消，请重新检查页面".into());
        }
    }
    if let (Some(reference), Some(expected_reason)) =
        (optional_str(args, "elementRef")?, approved_risk.as_deref())
    {
        if risky_browser_element(browser, reference).await?.as_deref() != Some(expected_reason) {
            return Err("等待确认期间目标控件已变化，操作已取消".into());
        }
    }
    let result = match name {
        "browser_start" => {
            serde_json::to_value(browser.status().await?).map_err(|error| error.to_string())?
        }
        "browser_navigate" => browser.navigate(required_str(args, "url")?).await?,
        "browser_snapshot" => browser.snapshot().await?,
        "browser_screenshot" => {
            let (data, meta) = browser.screenshot().await?;
            drop(guard);
            manager.emit_status(session_id).await;
            return Ok(tool_image_result(meta, "image/png", data));
        }
        "browser_click" => {
            let reference = optional_str(args, "elementRef")?;
            browser
                .click(
                    reference,
                    optional_f64(args, "x")?,
                    optional_f64(args, "y")?,
                    optional_str(args, "button")?.unwrap_or("left"),
                    optional_u64(args, "clickCount")?.unwrap_or(1) as u32,
                )
                .await?
        }
        "browser_hover" => browser.hover(required_str(args, "elementRef")?).await?,
        "browser_type" => {
            let reference = required_str(args, "elementRef")?;
            browser
                .type_text(
                    reference,
                    required_str(args, "text")?,
                    optional_bool(args, "replace")?.unwrap_or(true),
                )
                .await?
        }
        "browser_select" => {
            let values = required_string_array(args, "values", 100)?;
            browser
                .select(required_str(args, "elementRef")?, &values)
                .await?
        }
        "browser_upload" => {
            browser
                .upload(required_str(args, "elementRef")?, &upload_paths)
                .await?
        }
        "browser_key" => {
            let key = required_str(args, "key")?;
            browser
                .key(key, &optional_string_array(args, "modifiers", 4)?)
                .await?
        }
        "browser_scroll" => {
            browser
                .scroll(
                    optional_f64(args, "deltaX")?.unwrap_or(0.0),
                    required_f64(args, "deltaY")?,
                )
                .await?
        }
        "browser_drag" => {
            browser
                .drag(
                    required_f64(args, "fromX")?,
                    required_f64(args, "fromY")?,
                    required_f64(args, "toX")?,
                    required_f64(args, "toY")?,
                )
                .await?
        }
        "browser_tabs" => match optional_str(args, "action")?.unwrap_or("list") {
            "list" => {
                serde_json::to_value(browser.tabs().await?).map_err(|error| error.to_string())?
            }
            "new" => serde_json::to_value(browser.new_tab(optional_str(args, "url")?).await?)
                .map_err(|error| error.to_string())?,
            "select" => {
                serde_json::to_value(browser.select_tab(required_str(args, "targetId")?).await?)
                    .map_err(|error| error.to_string())?
            }
            "close" => browser.close_tab(required_str(args, "targetId")?).await?,
            _ => return Err("tabs action 必须是 list、new、select 或 close".into()),
        },
        "browser_wait" => {
            browser
                .wait(optional_u64(args, "milliseconds")?.unwrap_or(1_000))
                .await?
        }
        "browser_downloads" => {
            serde_json::to_value(browser.downloads()?).map_err(|error| error.to_string())?
        }
        _ => return Err(format!("unknown browser tool: {name}")),
    };
    browser.enforce_current_url_policy().await?;
    drop(guard);
    manager.emit_status(session_id).await;
    Ok(tool_json_result(result))
}

async fn risky_browser_element(
    browser: &mut BrowserController,
    reference: &str,
) -> Result<Option<String>, String> {
    let snapshot = browser.snapshot().await?;
    let element = snapshot
        .get("elements")
        .and_then(Value::as_array)
        .and_then(|elements| {
            elements
                .iter()
                .find(|element| element.get("ref").and_then(Value::as_str) == Some(reference))
        });
    let Some(element) = element else {
        return Ok(None);
    };
    let searchable = ["name", "href", "type"]
        .into_iter()
        .filter_map(|key| element.get(key).and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    const RISKY: [&str; 24] = [
        "pay", "purchase", "buy", "checkout", "order", "submit", "send", "publish", "post",
        "delete", "remove", "confirm", "accept", "agree", "sign in", "log in", "付款", "购买",
        "下单", "发送", "发布", "删除", "确认", "同意",
    ];
    if RISKY.iter().any(|keyword| searchable.contains(keyword)) {
        let label = element
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("未命名控件");
        return Ok(Some(format!(
            "即将点击“{label}”。该控件可能提交、发送、购买、删除或确认重要操作。"
        )));
    }
    Ok(None)
}

async fn browser_element_is_password(
    browser: &mut BrowserController,
    reference: &str,
) -> Result<bool, String> {
    let snapshot = browser.snapshot().await?;
    Ok(snapshot
        .get("elements")
        .and_then(Value::as_array)
        .is_some_and(|elements| {
            elements.iter().any(|element| {
                element.get("ref").and_then(Value::as_str) == Some(reference)
                    && element.get("type").and_then(Value::as_str) == Some("password")
            })
        }))
}

async fn computer_tool(
    manager: &Arc<AutomationManager>,
    session_id: &str,
    name: &str,
    args: &Value,
) -> Result<Value, String> {
    let session = manager
        .ensure_active(session_id, AutomationMode::ComputerUse)
        .await?;
    let result = match name {
        "computer_capabilities" => serde_json::to_value(ComputerController::capability())
            .map_err(|error| error.to_string())?,
        "computer_displays" => serde_json::to_value(ComputerController::displays()?)
            .map_err(|error| error.to_string())?,
        "computer_screenshot" => {
            let frame = session
                .computer
                .lock()
                .unwrap()
                .screenshot(optional_str(args, "displayId")?)?;
            let meta = serde_json::to_value(&frame.meta).map_err(|error| error.to_string())?;
            return Ok(tool_image_result(meta, "image/png", frame.png_base64));
        }
        "computer_move" => {
            let (x, y) = session.computer.lock().unwrap().move_pointer(
                required_str(args, "frameId")?,
                required_f64(args, "x")?,
                required_f64(args, "y")?,
            )?;
            json!({ "moved": true, "desktopX": x, "desktopY": y, "frameInvalidated": true })
        }
        "computer_click" => {
            if optional_bool(args, "consequential")?.unwrap_or(false) {
                manager
                    .approve(
                        session_id,
                        name,
                        "确认电脑上的重要操作",
                        optional_str(args, "intent")?.unwrap_or("该点击可能产生外部或不可逆影响。"),
                        args.clone(),
                    )
                    .await?;
                manager
                    .ensure_active(session_id, AutomationMode::ComputerUse)
                    .await?;
            }
            let (x, y) = session.computer.lock().unwrap().click(
                required_str(args, "frameId")?,
                required_f64(args, "x")?,
                required_f64(args, "y")?,
                optional_str(args, "button")?.unwrap_or("left"),
                optional_u64(args, "clickCount")?.unwrap_or(1) as u32,
            )?;
            json!({ "clicked": true, "desktopX": x, "desktopY": y, "frameInvalidated": true })
        }
        "computer_drag" => {
            session.computer.lock().unwrap().drag(
                required_str(args, "frameId")?,
                required_f64(args, "fromX")?,
                required_f64(args, "fromY")?,
                required_f64(args, "toX")?,
                required_f64(args, "toY")?,
                optional_u64(args, "durationMs")?.unwrap_or(500),
            )?;
            json!({ "dragged": true, "frameInvalidated": true })
        }
        "computer_scroll" => {
            let delta_x = optional_i64(args, "deltaX")?
                .unwrap_or(0)
                .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32;
            let delta_y = required_i64(args, "deltaY")?
                .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32;
            session.computer.lock().unwrap().scroll(
                required_str(args, "frameId")?,
                delta_x,
                delta_y,
            )?;
            json!({ "scrolled": true, "frameInvalidated": true })
        }
        "computer_type" => {
            let sensitive = optional_bool(args, "sensitive")?.unwrap_or(false);
            let consequential = optional_bool(args, "consequential")?.unwrap_or(false);
            if sensitive || consequential {
                manager
                    .approve(
                        session_id,
                        name,
                        if sensitive { "确认填写敏感信息" } else { "确认发送或发布文本" },
                        optional_str(args, "intent")?.unwrap_or(if sensitive {
                            "即将在当前电脑窗口中填写敏感文本。文本内容不会显示在确认卡片中。"
                        } else {
                            "输入内容可能被发送、发布或提交到外部系统。"
                        }),
                        json!({ "characters": required_str(args, "text")?.chars().count(), "sensitive": sensitive, "consequential": consequential }),
                    )
                    .await?;
                manager
                    .ensure_active(session_id, AutomationMode::ComputerUse)
                    .await?;
            }
            session
                .computer
                .lock()
                .unwrap()
                .type_text(required_str(args, "frameId")?, required_str(args, "text")?)?;
            json!({ "typed": true, "characters": required_str(args, "text")?.chars().count(), "frameInvalidated": true })
        }
        "computer_key" => {
            let key = required_str(args, "key")?;
            let modifiers = optional_string_array(args, "modifiers", 4)?;
            let implicit_consequential =
                matches!(key.to_ascii_lowercase().as_str(), "enter" | "return")
                    || modifiers.iter().any(|modifier| {
                        matches!(
                            modifier.to_ascii_lowercase().as_str(),
                            "cmd" | "command" | "meta" | "ctrl" | "control"
                        )
                    });
            if optional_bool(args, "consequential")?.unwrap_or(false) || implicit_consequential {
                manager
                    .approve(
                        session_id,
                        name,
                        "确认电脑快捷键操作",
                        optional_str(args, "intent")?
                            .unwrap_or("该按键可能提交内容、执行快捷命令或改变外部状态。"),
                        json!({ "key": key, "modifiers": modifiers }),
                    )
                    .await?;
                manager
                    .ensure_active(session_id, AutomationMode::ComputerUse)
                    .await?;
            }
            session.computer.lock().unwrap().key(
                required_str(args, "frameId")?,
                key,
                &modifiers,
            )?;
            json!({ "pressed": key, "modifiers": modifiers, "frameInvalidated": true })
        }
        "computer_wait" => {
            let milliseconds = optional_u64(args, "milliseconds")?
                .unwrap_or(1_000)
                .clamp(50, 30_000);
            tokio::time::sleep(Duration::from_millis(milliseconds)).await;
            session.computer.lock().unwrap().invalidate_frame();
            json!({ "waitedMs": milliseconds })
        }
        _ => return Err(format!("unknown computer tool: {name}")),
    };
    Ok(tool_json_result(result))
}

fn tool_json_result(value: Value) -> Value {
    json!({
        "content": [{ "type": "text", "text": value.to_string() }],
        "isError": false,
    })
}

fn tool_image_result(meta: Value, mime_type: &str, data: String) -> Value {
    json!({
        "content": [
            { "type": "text", "text": meta.to_string() },
            { "type": "image", "mimeType": mime_type, "data": data }
        ],
        "isError": false,
    })
}

fn tool_error_result(message: &str) -> Value {
    let truncated = message.chars().count() > 8_192;
    let message = message.chars().take(8_192).collect::<String>();
    let message = if truncated {
        format!("{message}…")
    } else {
        message
    };
    json!({ "content": [{ "type": "text", "text": message }], "isError": true })
}

fn rpc_result(id: Value, result: Value) -> Response {
    let body = json!({ "jsonrpc": "2.0", "id": id, "result": result });
    let text = body.to_string();
    if text.len() > MAX_RPC_RESPONSE_BYTES {
        return rpc_error(Value::Null, -32603, "response exceeds 24MB limit".into());
    }
    ([(header::CONTENT_TYPE, "application/json")], text).into_response()
}

fn rpc_error(id: Value, code: i64, message: String) -> Response {
    (
        [(header::CONTENT_TYPE, "application/json")],
        json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
            .to_string(),
    )
        .into_response()
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

fn validate_session_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.chars().count() > MAX_SESSION_ID_CHARS
        || value.chars().any(char::is_control)
    {
        Err("自动化会话 ID 无效".into())
    } else {
        Ok(())
    }
}

fn validate_upload_paths(
    manager: &AutomationManager,
    session_id: &str,
    args: &Value,
) -> Result<Vec<String>, String> {
    const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;
    const MAX_TOTAL_BYTES: u64 = 500 * 1024 * 1024;

    let requested = required_string_array(args, "paths", 20)?;
    let state = manager.app.state::<crate::commands::AppState>();
    let workspace = state.session_workspace(session_id)?;
    let workspace = workspace
        .canonicalize()
        .map_err(|error| format!("无法校验任务工作区：{error}"))?;
    let mut total_bytes = 0_u64;
    let mut canonical_paths = Vec::with_capacity(requested.len());
    for requested_path in requested {
        if requested_path.chars().any(char::is_control) {
            return Err("上传文件路径无效".into());
        }
        let raw = std::path::PathBuf::from(&requested_path);
        let candidate = if raw.is_absolute() {
            raw
        } else {
            workspace.join(raw)
        };
        let canonical = candidate
            .canonicalize()
            .map_err(|error| format!("无法读取待上传文件 {} ：{error}", candidate.display()))?;
        if !canonical.starts_with(&workspace) {
            return Err("为防止本地数据泄露，Browser Use 只允许上传当前任务工作区内的文件".into());
        }
        let metadata = std::fs::metadata(&canonical)
            .map_err(|error| format!("无法检查待上传文件：{error}"))?;
        if !metadata.is_file() {
            return Err(format!("只能上传普通文件：{}", canonical.display()));
        }
        if metadata.len() > MAX_FILE_BYTES {
            return Err(format!(
                "单个上传文件不能超过 100MB：{}",
                canonical.display()
            ));
        }
        total_bytes = total_bytes
            .checked_add(metadata.len())
            .ok_or_else(|| "上传文件总大小溢出".to_string())?;
        if total_bytes > MAX_TOTAL_BYTES {
            return Err("单次上传文件总大小不能超过 500MB".into());
        }
        canonical_paths.push(canonical.to_string_lossy().into_owned());
    }
    Ok(canonical_paths)
}

fn required_str<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("缺少字符串参数 {key}"))
}

fn optional_str<'a>(value: &'a Value, key: &str) -> Result<Option<&'a str>, String> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value)),
        _ => Err(format!("参数 {key} 必须是字符串")),
    }
}

fn required_f64(value: &Value, key: &str) -> Result<f64, String> {
    optional_f64(value, key)?.ok_or_else(|| format!("缺少数字参数 {key}"))
}

fn optional_f64(value: &Value, key: &str) -> Result<Option<f64>, String> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_f64()
            .filter(|value| value.is_finite())
            .map(Some)
            .ok_or_else(|| format!("参数 {key} 必须是有限数字")),
    }
}

fn required_i64(value: &Value, key: &str) -> Result<i64, String> {
    optional_i64(value, key)?.ok_or_else(|| format!("缺少整数参数 {key}"))
}

fn optional_i64(value: &Value, key: &str) -> Result<Option<i64>, String> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_i64()
            .map(Some)
            .ok_or_else(|| format!("参数 {key} 必须是整数")),
    }
}

fn optional_u64(value: &Value, key: &str) -> Result<Option<u64>, String> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .map(Some)
            .ok_or_else(|| format!("参数 {key} 必须是非负整数")),
    }
}

fn optional_bool(value: &Value, key: &str) -> Result<Option<bool>, String> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_bool()
            .map(Some)
            .ok_or_else(|| format!("参数 {key} 必须是布尔值")),
    }
}

fn required_string_array(value: &Value, key: &str, max: usize) -> Result<Vec<String>, String> {
    let values = optional_string_array(value, key, max)?;
    if values.is_empty() {
        Err(format!("参数 {key} 不能为空"))
    } else {
        Ok(values)
    }
}

fn optional_string_array(value: &Value, key: &str, max: usize) -> Result<Vec<String>, String> {
    let Some(raw) = value.get(key) else {
        return Ok(Vec::new());
    };
    let values = raw
        .as_array()
        .ok_or_else(|| format!("参数 {key} 必须是字符串数组"))?;
    if values.len() > max {
        return Err(format!("参数 {key} 数量超过 {max}"));
    }
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| format!("参数 {key} 必须是字符串数组"))
        })
        .collect()
}

/// Persist the rotating loopback endpoint after the first live session exists.
pub fn persist_registration(tx: &echo_agent_acp::AcpAgentTx, session_id: &str) {
    {
        let mut done = PERSISTED.lock().unwrap();
        if *done {
            return;
        }
        *done = true;
    }
    let (Some(url), Some(authorization)) = (server_url(), authorization_header()) else {
        *PERSISTED.lock().unwrap() = false;
        return;
    };
    let tx = tx.clone();
    let session_id = session_id.to_string();
    tokio::spawn(async move {
        let mut headers = serde_json::Map::new();
        headers.insert(AUTH_HEADER.into(), Value::String(authorization));
        headers.insert(SESSION_HEADER.into(), Value::String("${session_id}".into()));
        let payload = json!({
            "session_id": session_id,
            "server_name": MCP_SERVER_NAME,
            "url": url,
            "headers": headers,
            "enabled": true,
        });
        if let Err(error) = crate::ext::call_ext_value(
            &tx,
            "echo.agent/mcp/upsert",
            crate::ext::raw_params(&payload),
        )
        .await
        {
            tracing::warn!(?error, "automation MCP registration failed");
            *PERSISTED.lock().unwrap() = false;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes_are_explicit_and_closed() {
        assert_eq!(
            AutomationMode::parse("browser").unwrap(),
            AutomationMode::BrowserUse
        );
        assert_eq!(
            AutomationMode::parse("computer_use").unwrap(),
            AutomationMode::ComputerUse
        );
        assert!(AutomationMode::parse("unsafe").is_err());
    }

    #[test]
    fn tool_schema_disallows_unknown_fields() {
        let listed = tools_list_result();
        let tools = listed["tools"].as_array().unwrap();
        assert!(tools.len() >= 20);
        assert!(tools
            .iter()
            .all(|tool| tool["inputSchema"]["additionalProperties"] == false));
    }

    #[test]
    fn session_ids_reject_control_characters() {
        assert!(validate_session_id("session-1").is_ok());
        assert!(validate_session_id("bad\nvalue").is_err());
    }
}
