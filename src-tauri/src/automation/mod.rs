//! Built-in Browser Use and Computer Use service.
//!
//! The embedded Runtime already consumes MCP and expands `${session_id}` in
//! HTTP headers. This module uses that trusted session binding rather than an
//! LLM-supplied argument, so automation state cannot cross task boundaries.

mod browser;
mod computer;
mod network_proxy;

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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::RwLockReadGuard;
use tokio::sync::{oneshot, Mutex as AsyncMutex, RwLock as AsyncRwLock};
use tokio_util::sync::CancellationToken;

pub const MCP_SERVER_NAME: &str = "echoagent-automation";
pub const AUTH_HEADER: &str = "Authorization";
pub const SESSION_HEADER: &str = "X-EchoAgent-Session-Id";
const MAX_MCP_BODY_BYTES: usize = 256 * 1024;
const MAX_RPC_RESPONSE_BYTES: usize = 24 * 1024 * 1024;
const MAX_TOOL_ARGUMENT_BYTES: usize = 128 * 1024;
const MAX_SESSION_ID_CHARS: usize = 256;
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const SERVER_START_TIMEOUT: Duration = Duration::from_secs(5);

/// 工具白名单：无论任务级权限模式（ask/auto/always-approve）如何，
/// 都必须在执行前经用户独立确认。这是为了保护用户真实桌面——
/// AI 一旦自动执行 click/drag/type/key，可能造成不可逆后果
///（购买、删除、确认对话框、退出应用、键盘快捷键误触）。
///
/// 与任务级 PermissionMode::always-approve 是正交的两套安全机制：
/// - always-approve 控制"分类器/审批模式"
/// - 本列表控制"真实桌面上的副作用"
///
pub(crate) const ALWAYS_CONFIRM_TOOLS: &[&str] = &[
    "computer_click",
    "computer_drag",
    "computer_type",
    "computer_key",
];

pub(crate) fn requires_independent_confirmation(tool_name: &str) -> bool {
    ALWAYS_CONFIRM_TOOLS.contains(&tool_name)
}

static SERVICE: OnceLock<Arc<AutomationService>> = OnceLock::new();
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
    pub browser_has_data: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationCapabilities {
    pub browser: browser::BrowserCapability,
    pub computer: computer::ComputerCapability,
}

struct AutomationSession {
    mode: Mutex<AutomationMode>,
    paused: Mutex<bool>,
    allow_private_network: Mutex<bool>,
    browser: AsyncMutex<Option<BrowserController>>,
    computer: Mutex<ComputerController>,
    action_token: Mutex<CancellationToken>,
    execution_gate: AsyncRwLock<()>,
}

impl AutomationSession {
    fn new(mode: AutomationMode) -> Self {
        // A restored task must never silently regain control after an app
        // restart. A deliberate mode switch starts active; restoring an
        // already-automated task starts paused until the user resumes in UI.
        let restored_automation = mode != AutomationMode::Default;
        Self {
            mode: Mutex::new(mode),
            paused: Mutex::new(restored_automation),
            allow_private_network: Mutex::new(false),
            browser: AsyncMutex::new(None),
            computer: Mutex::new(ComputerController::default()),
            action_token: Mutex::new(CancellationToken::new()),
            execution_gate: AsyncRwLock::new(()),
        }
    }

    fn action_token(&self) -> CancellationToken {
        self.action_token.lock().unwrap().clone()
    }

    fn cancel_actions(&self) {
        self.action_token.lock().unwrap().cancel();
    }

    fn reset_action_token(&self) {
        *self.action_token.lock().unwrap() = CancellationToken::new();
    }
}

async fn enter_action<'a>(
    session: &'a AutomationSession,
    token: &CancellationToken,
    required: AutomationMode,
) -> Result<RwLockReadGuard<'a, ()>, String> {
    let guard = session.execution_gate.read().await;
    if token.is_cancelled() || *session.paused.lock().unwrap() {
        return Err("自动化已暂停。用户接管期间不会执行任何浏览器或电脑操作。".into());
    }
    if *session.mode.lock().unwrap() != required {
        return Err("任务模式已变化，本次自动化操作已取消".into());
    }
    Ok(guard)
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

struct BrowserApprovalPlan {
    title: String,
    description: String,
    details: Value,
    expected_url: String,
    expected_target: Option<(String, Value)>,
}

struct AutomationManager {
    app: AppHandle,
    sessions: AsyncMutex<HashMap<String, Arc<AutomationSession>>>,
    approvals: AsyncMutex<HashMap<String, PendingApproval>>,
}

struct AutomationService {
    manager: Arc<AutomationManager>,
    port: u16,
    token: String,
    ready: AtomicBool,
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
        session.cancel_actions();
        self.reject_session_approvals(session_id).await;
        let _exclusive = session.execution_gate.write().await;
        *session.mode.lock().unwrap() = mode;
        *session.paused.lock().unwrap() = false;
        session.reset_action_token();
        if !mode.allows_browser() {
            if let Some(mut browser) = session.browser.lock().await.take() {
                let _ = browser.stop().await;
            }
        }
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
            browser_has_data: browser::profile_exists(session_id),
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
                    "当前任务未开启操作网页，请从输入框的 + 菜单开启".into()
                }
                AutomationMode::ComputerUse => {
                    "当前任务未开启操作电脑，请从输入框的 + 菜单开启".into()
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
        if paused {
            // Cancel first, then wait for the exclusive gate. Once this method
            // returns, no action admitted under the old token can still run.
            session.cancel_actions();
            *session.paused.lock().unwrap() = true;
            // Taking over is a hard boundary: no earlier approval request may
            // remain live and resume an operation behind the user's back.
            self.reject_session_approvals(session_id).await;
            let _exclusive = session.execution_gate.write().await;
        } else {
            let _exclusive = session.execution_gate.write().await;
            session.reset_action_token();
            *session.paused.lock().unwrap() = false;
        }
        self.emit_status(session_id).await;
        Ok(())
    }

    async fn stop(&self, session_id: &str) -> Result<(), String> {
        let session = self.session(session_id).await?;
        session.cancel_actions();
        *session.paused.lock().unwrap() = true;
        self.reject_session_approvals(session_id).await;
        let _exclusive = session.execution_gate.write().await;
        let browser_result = if let Some(mut browser) = session.browser.lock().await.take() {
            browser.stop().await
        } else {
            Ok(())
        };
        self.emit_status(session_id).await;
        browser_result
    }

    async fn clear_browser_data(&self, session_id: &str) -> Result<(), String> {
        self.stop(session_id).await?;
        browser::remove_profile(session_id).await
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
        cancellation: &CancellationToken,
    ) -> Result<(), String> {
        if cancellation.is_cancelled() {
            return Err("自动化已暂停，操作未进入确认阶段".into());
        }
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
        let result = tokio::select! {
            _ = cancellation.cancelled() => {
                Err("自动化已暂停，待确认操作已取消".into())
            }
            response = tokio::time::timeout(APPROVAL_TIMEOUT, rx) => match response {
            Ok(Ok(true)) => Ok(()),
            Ok(Ok(false)) => Err("用户拒绝了该高风险自动化操作".into()),
            Ok(Err(_)) => Err("自动化安全确认已关闭，操作未执行".into()),
            Err(_) => Err("自动化安全确认等待超时，操作未执行".into()),
            }
        };
        // The normal UI resolution path already removes the request and emits
        // this event. Cancellation and timeout have no UI caller, so close the
        // card here instead of leaving a stale decision on screen.
        if self.approvals.lock().await.remove(&request_id).is_some() {
            let _ = self.app.emit(
                "automation://approval-closed",
                json!({ "requestId": request_id, "sessionId": session_id }),
            );
        }
        result
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
    let service = SERVICE
        .get()
        .ok_or_else(|| "自动化服务尚未启动".to_string())?;
    if !service.ready.load(Ordering::Acquire) {
        return Err(automation_service_unavailable_reason());
    }
    Ok(&service.manager)
}

fn automation_service_unavailable_reason() -> String {
    "自动化服务未就绪，请重启 EchoAgent 后重试".to_string()
}

pub fn serve(app: AppHandle) -> Result<(), String> {
    if let Some(service) = SERVICE.get() {
        return if service.ready.load(Ordering::Acquire) {
            Ok(())
        } else {
            Err(automation_service_unavailable_reason())
        };
    }
    let listener = bind_loopback()
        .ok_or_else(|| "automation MCP: failed to bind loopback socket".to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("automation MCP: failed to read bound address: {error}"))?
        .port();
    let token = uuid::Uuid::now_v7().to_string();
    let authorization = format!("Bearer {token}");
    let service = Arc::new(AutomationService {
        manager: Arc::new(AutomationManager::new(app)),
        port,
        token,
        ready: AtomicBool::new(false),
    });
    if SERVICE.set(service.clone()).is_err() {
        return Err("automation MCP: process state was initialized twice".to_string());
    }

    // Tauri invokes setup on the native event-loop thread, which is not entered
    // into Tokio's IO runtime. Keep both std -> Tokio registration and Axum on
    // Tauri's runtime. A bounded startup acknowledgement prevents sessions from
    // observing an endpoint that has not actually been registered yet.
    let (startup_tx, startup_rx) = std::sync::mpsc::sync_channel(1);
    let task_service = service.clone();
    tauri::async_runtime::spawn(async move {
        let listener = match to_tokio_listener(listener).await {
            Ok(listener) => listener,
            Err(error) => {
                let message = format!("automation MCP: failed to register listener: {error}");
                let _ = startup_tx.send(Err(message));
                return;
            }
        };
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
                manager: task_service.manager.clone(),
            });

        task_service.ready.store(true, Ordering::Release);
        let _ = startup_tx.send(Ok(()));
        tracing::info!(port, "automation MCP server listening");
        if let Err(error) = axum::serve(listener, router).await {
            tracing::error!(%error, "automation MCP server stopped");
        }
        task_service.ready.store(false, Ordering::Release);
        if let Ok(mut persisted) = PERSISTED.lock() {
            *persisted = false;
        }
    });

    match startup_rx.recv_timeout(SERVER_START_TIMEOUT) {
        Ok(result) => result,
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            Err("automation MCP: startup task stopped unexpectedly".to_string())
        }
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            tracing::warn!(
                timeout_seconds = SERVER_START_TIMEOUT.as_secs(),
                "automation MCP startup acknowledgement timed out; continuing in degraded mode"
            );
            Ok(())
        }
    }
}

fn bind_loopback() -> Option<TcpListener> {
    TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).ok()
}

async fn to_tokio_listener(listener: TcpListener) -> std::io::Result<tokio::net::TcpListener> {
    listener.set_nonblocking(true)?;
    tokio::net::TcpListener::from_std(listener)
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
                    .unwrap_or_else(|| "操作网页当前不可用".into()))
            }
        }
        AutomationMode::ComputerUse => {
            let capability = ComputerController::capability();
            if capability.available {
                Ok(())
            } else {
                Err(capability
                    .reason
                    .unwrap_or_else(|| "操作电脑当前不可用".into()))
            }
        }
    }
}

pub async fn forget_session(session_id: &str) {
    if let Some(service) = SERVICE.get() {
        service.manager.forget_session(session_id).await;
    }
}

pub async fn pause_session(session_id: &str) -> Result<(), String> {
    manager()?.pause(session_id, true).await
}

pub async fn stop_session(session_id: &str) -> Result<(), String> {
    manager()?.stop(session_id).await
}

pub async fn shutdown_all() {
    if let Some(service) = SERVICE.get() {
        service.manager.shutdown_all().await;
    }
}

#[tauri::command]
pub fn automation_capabilities() -> AutomationCapabilities {
    let mut capabilities = AutomationCapabilities {
        browser: browser::capability(),
        computer: ComputerController::capability(),
    };
    let ready = SERVICE
        .get()
        .is_some_and(|service| service.ready.load(Ordering::Acquire));
    if !ready {
        let reason = automation_service_unavailable_reason();
        capabilities.browser.available = false;
        capabilities.browser.reason = Some(reason.clone());
        capabilities.computer.available = false;
        capabilities.computer.reason = Some(reason);
    }
    capabilities
}

#[tauri::command]
pub async fn automation_status(session_id: String) -> Result<AutomationStatus, String> {
    manager()?.status(&session_id).await
}

#[tauri::command]
pub async fn automation_clear_browser_data(session_id: String) -> Result<AutomationStatus, String> {
    manager()?.clear_browser_data(&session_id).await?;
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
        let approval_token = CancellationToken::new();
        manager()?
            .approve(
                &session_id,
                "automation_set_private_network",
                "允许访问本机和内网",
                "受控浏览器将可以访问环回地址、局域网和企业内网。网页可能接触本机服务，请确认当前任务确实需要此权限。",
                json!({ "allowed": true }),
                &approval_token,
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
        tool("automation_stop", "Stop the controlled browser and all automation for this task.", object_schema(&[])),

        tool("browser_start", "Start the task-isolated controlled browser. Call before other browser tools.", object_schema(&[])),
        tool("browser_navigate", "Navigate the controlled browser to an absolute public http/https URL and wait for DOM readiness.", schema(json!({ "url": {"type":"string","maxLength":4096} }), &["url"])),
        tool("browser_snapshot", "Return current page title, URL, readable text and interactive elements with stable element refs.", object_schema(&[])),
        tool("browser_screenshot", "Capture the visible controlled-browser viewport. Returns an image and viewport metadata.", object_schema(&[])),
        tool("browser_click", "Click an element ref from browser_snapshot, or viewport coordinates. Every click requires independent user confirmation.", schema(json!({
            "elementRef":{"type":"string","maxLength":128}, "x":{"type":"number"}, "y":{"type":"number"},
            "button":{"type":"string","enum":["left","right","middle"],"default":"left"}, "clickCount":{"type":"integer","minimum":1,"maximum":3,"default":1}
        }), &[])),
        tool("browser_hover", "Move the browser pointer over an element ref.", schema(json!({"elementRef":{"type":"string","maxLength":128}}), &["elementRef"])),
        tool("browser_type", "Focus an input/contenteditable element and type text after confirmation. Password fields must be completed manually during user takeover; never pass credentials to this tool.", schema(json!({
            "elementRef":{"type":"string","maxLength":128}, "text":{"type":"string","maxLength":65536}, "replace":{"type":"boolean","default":true}
        }), &["elementRef","text"])),
        tool("browser_select", "Select one or more values/text labels in a select element after user confirmation.", schema(json!({
            "elementRef":{"type":"string","maxLength":128}, "values":{"type":"array","minItems":1,"maxItems":100,"items":{"type":"string","maxLength":1024}}
        }), &["elementRef","values"])),
        tool("browser_upload", "Upload workspace files through a file input. This always pauses for user confirmation before any file is disclosed to the website.", schema(json!({
            "elementRef":{"type":"string","maxLength":128}, "paths":{"type":"array","minItems":1,"maxItems":20,"items":{"type":"string","maxLength":4096}}
        }), &["elementRef","paths"])),
        tool("browser_key", "Press one browser key with optional modifiers after user confirmation.", schema(json!({
            "key":{"type":"string","maxLength":64}, "modifiers":{"type":"array","maxItems":4,"items":{"type":"string","enum":["shift","ctrl","control","alt","option","cmd","command","meta"]}}
        }), &["key"])),
        tool("browser_scroll", "Scroll the current browser viewport by pixel deltas.", schema(json!({"deltaX":{"type":"number","default":0},"deltaY":{"type":"number"}}), &["deltaY"])),
        tool("browser_drag", "Drag between two viewport coordinates after user confirmation.", schema(json!({"fromX":{"type":"number"},"fromY":{"type":"number"},"toX":{"type":"number"},"toY":{"type":"number"}}), &["fromX","fromY","toX","toY"])),
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
        tool("computer_click", "Click using coordinates from a current screenshot after user confirmation. The frame is invalidated after the action.", schema(json!({
            "frameId":{"type":"string"},"x":{"type":"number"},"y":{"type":"number"},"button":{"type":"string","enum":["left","right","middle"],"default":"left"},"clickCount":{"type":"integer","minimum":1,"maximum":3,"default":1}
        }), &["frameId","x","y"])),
        tool("computer_drag", "Drag between two coordinates from a current screenshot after user confirmation and invalidate the frame.", schema(json!({
            "frameId":{"type":"string"},"fromX":{"type":"number"},"fromY":{"type":"number"},"toX":{"type":"number"},"toY":{"type":"number"},"durationMs":{"type":"integer","minimum":100,"maximum":5000,"default":500}
        }), &["frameId","fromX","fromY","toX","toY"])),
        tool("computer_scroll", "Scroll the active desktop target using a current screenshot frame. Positive deltaY scrolls down and the frame is invalidated.", schema(json!({"frameId":{"type":"string"},"deltaX":{"type":"integer","default":0},"deltaY":{"type":"integer"}}), &["frameId","deltaY"])),
        tool("computer_type", "Type text into the focused desktop control after user confirmation. Text is never shown in the confirmation card.", schema(json!({
            "frameId":{"type":"string"},"text":{"type":"string","maxLength":65536}
        }), &["frameId","text"])),
        tool("computer_key", "Press a desktop key with optional modifiers after user confirmation.", schema(json!({
            "frameId":{"type":"string"},"key":{"type":"string","maxLength":64},"modifiers":{"type":"array","maxItems":4,"items":{"type":"string"}}
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
    let action_token = session.action_token();
    if name == "browser_stop" {
        let _action_guard =
            enter_action(&session, &action_token, AutomationMode::BrowserUse).await?;
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
    let upload_paths = if name == "browser_upload" {
        validate_upload_paths(manager, session_id, args)?
    } else {
        Vec::new()
    };
    let approval_plan = if matches!(
        name,
        "browser_click"
            | "browser_type"
            | "browser_select"
            | "browser_upload"
            | "browser_key"
            | "browser_drag"
    ) {
        let reference = match name {
            "browser_type" | "browser_select" | "browser_upload" => {
                Some(required_str(args, "elementRef")?)
            }
            "browser_click" => optional_str(args, "elementRef")?,
            _ => None,
        };
        if name == "browser_click" && reference.is_none() {
            required_f64(args, "x")?;
            required_f64(args, "y")?;
        }
        let mut guard = session.browser.lock().await;
        let browser = guard.as_mut().expect("browser inserted above");
        let (url, page_title, target) = browser_approval_context(browser, reference).await?;
        let common = json!({
            "url": url,
            "pageTitle": page_title,
            "target": target,
        });
        let (title, description, details) = match name {
            "browser_click" => {
                let high_risk = target.as_ref().is_some_and(browser_target_looks_risky);
                let title = if high_risk {
                    "确认网页上的重要点击"
                } else {
                    "确认网页点击"
                };
                let description = if high_risk {
                    "该控件可能发送、购买、删除或确认重要操作。请核对网站和目标后继续。"
                } else {
                    "代理即将点击当前网页。请核对网站和目标后继续。"
                };
                (
                    title,
                    description,
                    merge_json(
                        common,
                        json!({
                            "x": optional_f64(args, "x")?,
                            "y": optional_f64(args, "y")?,
                            "button": optional_str(args, "button")?.unwrap_or("left"),
                            "clickCount": optional_u64(args, "clickCount")?.unwrap_or(1),
                        }),
                    ),
                )
            }
            "browser_type" => {
                let password = target
                    .as_ref()
                    .and_then(|value| value.get("type"))
                    .and_then(Value::as_str)
                    == Some("password");
                if password {
                    return Err("为保护凭据，代理不能接收或填写密码框。请暂停自动化，请用户接管受控浏览器完成填写，再由用户点击“继续”。".into());
                }
                (
                    "确认向网页填写文本",
                    "文本可能在输入时立即发送给网站。为保护隐私，确认卡片不显示具体内容。",
                    merge_json(
                        common,
                        json!({
                            "characters": required_str(args, "text")?.chars().count(),
                            "passwordField": password,
                            "replace": optional_bool(args, "replace")?.unwrap_or(true),
                        }),
                    ),
                )
            }
            "browser_select" => (
                "确认更改网页选项",
                "更改选项可能立即触发网站操作。请核对目标后继续。",
                merge_json(
                    common,
                    json!({ "selectionCount": required_string_array(args, "values", 100)?.len() }),
                ),
            ),
            "browser_upload" => {
                let names = upload_paths
                    .iter()
                    .filter_map(|path| std::path::Path::new(path).file_name())
                    .map(|name| name.to_string_lossy().into_owned())
                    .collect::<Vec<_>>();
                (
                    "确认向网站上传文件",
                    "文件内容将离开本机并提交给当前网站。仅允许上传当前任务工作区内的普通文件。",
                    merge_json(
                        common,
                        json!({ "files": names, "fileCount": upload_paths.len() }),
                    ),
                )
            }
            "browser_key" => (
                "确认网页按键操作",
                "按键或快捷键可能提交内容、执行命令或改变网站状态。",
                merge_json(
                    common,
                    json!({
                        "key": required_str(args, "key")?,
                        "modifiers": optional_string_array(args, "modifiers", 4)?,
                    }),
                ),
            ),
            "browser_drag" => (
                "确认网页拖动操作",
                "拖动可能更改顺序、位置或触发网站操作。",
                merge_json(
                    common,
                    json!({
                        "fromX": required_f64(args, "fromX")?,
                        "fromY": required_f64(args, "fromY")?,
                        "toX": required_f64(args, "toX")?,
                        "toY": required_f64(args, "toY")?,
                    }),
                ),
            ),
            _ => unreachable!(),
        };
        Some(BrowserApprovalPlan {
            title: title.to_string(),
            description: description.to_string(),
            details,
            expected_url: url,
            expected_target: reference.map(str::to_string).zip(target),
        })
    } else {
        None
    };

    if let Some(plan) = approval_plan.as_ref() {
        manager
            .approve(
                session_id,
                name,
                &plan.title,
                &plan.description,
                plan.details.clone(),
                &action_token,
            )
            .await?;
    }

    let _action_guard = enter_action(&session, &action_token, AutomationMode::BrowserUse).await?;
    let operation = async {
        let mut guard = session.browser.lock().await;
        let browser = guard.as_mut().expect("browser inserted above");
        browser.enforce_current_url_policy().await?;
        if let Some(plan) = approval_plan {
            if browser.current_url().await? != plan.expected_url {
                return Err("等待确认期间网页已变化，为避免误操作已取消，请重新检查页面".into());
            }
            if let Some((reference, expected)) = plan.expected_target {
                let actual = browser_element_signature(browser, &reference).await?;
                if actual != expected {
                    return Err("等待确认期间目标控件已变化，操作已取消".into());
                }
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
                "list" => serde_json::to_value(browser.tabs().await?)
                    .map_err(|error| error.to_string())?,
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
    };
    if matches!(name, "browser_click" | "browser_key" | "browser_drag") {
        // These commands have paired press/release events. Once admitted,
        // finish the short sequence so a pause cannot strand a pressed mouse
        // button or keyboard key. pause() still waits on the execution gate,
        // therefore no action remains in flight when takeover returns.
        operation.await
    } else {
        tokio::select! {
            biased;
            _ = action_token.cancelled() => Err("自动化已暂停，正在执行的浏览器操作已取消".into()),
            result = operation => result,
        }
    }
}

async fn browser_approval_context(
    browser: &mut BrowserController,
    reference: Option<&str>,
) -> Result<(String, String, Option<Value>), String> {
    let snapshot = browser.snapshot().await?;
    let url = snapshot
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| "浏览器快照缺少当前网址".to_string())?
        .to_string();
    let title = snapshot
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let target = reference
        .map(|reference| element_signature_from_snapshot(&snapshot, reference))
        .transpose()?;
    Ok((url, title, target))
}

async fn browser_element_signature(
    browser: &mut BrowserController,
    reference: &str,
) -> Result<Value, String> {
    let snapshot = browser.snapshot().await?;
    element_signature_from_snapshot(&snapshot, reference)
}

fn element_signature_from_snapshot(snapshot: &Value, reference: &str) -> Result<Value, String> {
    let element = snapshot
        .get("elements")
        .and_then(Value::as_array)
        .and_then(|elements| {
            elements
                .iter()
                .find(|element| element.get("ref").and_then(Value::as_str) == Some(reference))
        })
        .ok_or_else(|| "页面元素已失效，请重新获取页面快照".to_string())?;
    // Deliberately exclude bounds, current value and checked state. Layout and
    // transient state may change while a user reads the card, but the semantic
    // identity of the approved target must remain stable. Password/value data
    // can therefore never enter an approval event either.
    Ok(json!({
        "ref": reference,
        "tag": element.get("tag").and_then(Value::as_str).unwrap_or_default(),
        "role": element.get("role").and_then(Value::as_str).unwrap_or_default(),
        "name": element.get("name").and_then(Value::as_str).unwrap_or_default(),
        "type": element.get("type").and_then(Value::as_str).unwrap_or_default(),
        "href": element.get("href").and_then(Value::as_str),
        "disabled": element.get("disabled").and_then(Value::as_bool).unwrap_or(false),
    }))
}

fn browser_target_looks_risky(element: &Value) -> bool {
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
    RISKY.iter().any(|keyword| searchable.contains(keyword))
}

fn merge_json(mut base: Value, extra: Value) -> Value {
    if let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) {
        base.extend(extra.clone());
    }
    base
}

struct ComputerApprovalPlan {
    title: &'static str,
    description: &'static str,
    details: Value,
}

fn computer_approval_plan(
    session: &AutomationSession,
    name: &str,
    args: &Value,
) -> Result<ComputerApprovalPlan, String> {
    let frame_id = required_str(args, "frameId")?;
    let frame = session.computer.lock().unwrap().frame_meta(frame_id)?;
    let frame_details = json!({
        "frameId": frame_id,
        "displayId": frame.display_id,
        "targetName": frame.target_name,
    });
    match name {
        "computer_click" => Ok(ComputerApprovalPlan {
            title: "确认电脑点击",
            description: "点击可能提交、发送、购买、删除或确认操作。请核对截图位置后继续。",
            details: merge_json(
                frame_details,
                json!({
                    "x": required_f64(args, "x")?,
                    "y": required_f64(args, "y")?,
                    "button": optional_str(args, "button")?.unwrap_or("left"),
                    "clickCount": optional_u64(args, "clickCount")?.unwrap_or(1),
                }),
            ),
        }),
        "computer_drag" => Ok(ComputerApprovalPlan {
            title: "确认电脑拖动操作",
            description: "拖动可能移动文件、改变顺序或触发应用操作。",
            details: merge_json(
                frame_details,
                json!({
                    "fromX": required_f64(args, "fromX")?,
                    "fromY": required_f64(args, "fromY")?,
                    "toX": required_f64(args, "toX")?,
                    "toY": required_f64(args, "toY")?,
                    "durationMs": optional_u64(args, "durationMs")?.unwrap_or(500),
                }),
            ),
        }),
        "computer_type" => Ok(ComputerApprovalPlan {
            title: "确认在电脑中输入文本",
            description:
                "文本可能被当前应用立即读取、发送或提交。为保护隐私，确认卡片不显示具体内容。",
            details: merge_json(
                frame_details,
                json!({
                    "characters": required_str(args, "text")?.chars().count(),
                }),
            ),
        }),
        "computer_key" => Ok(ComputerApprovalPlan {
            title: "确认电脑按键操作",
            description: "按键或快捷键可能提交内容、执行命令或改变应用状态。",
            details: merge_json(
                frame_details,
                json!({
                    "key": required_str(args, "key")?,
                    "modifiers": optional_string_array(args, "modifiers", 4)?,
                }),
            ),
        }),
        _ => Err(format!("missing independent confirmation plan for {name}")),
    }
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
    let action_token = session.action_token();
    if requires_independent_confirmation(name) {
        let plan = computer_approval_plan(&session, name, args)?;
        manager
            .approve(
                session_id,
                name,
                plan.title,
                plan.description,
                plan.details,
                &action_token,
            )
            .await?;
        manager
            .ensure_active(session_id, AutomationMode::ComputerUse)
            .await?;
    }
    let result = match name {
        "computer_capabilities" => serde_json::to_value(ComputerController::capability())
            .map_err(|error| error.to_string())?,
        "computer_displays" => serde_json::to_value(ComputerController::displays()?)
            .map_err(|error| error.to_string())?,
        "computer_screenshot" => {
            let _action_guard =
                enter_action(&session, &action_token, AutomationMode::ComputerUse).await?;
            let frame = session
                .computer
                .lock()
                .unwrap()
                .screenshot(optional_str(args, "displayId")?)?;
            let meta = serde_json::to_value(&frame.meta).map_err(|error| error.to_string())?;
            return Ok(tool_image_result(meta, "image/png", frame.png_base64));
        }
        "computer_move" => {
            let _action_guard =
                enter_action(&session, &action_token, AutomationMode::ComputerUse).await?;
            let (x, y) = session.computer.lock().unwrap().move_pointer(
                required_str(args, "frameId")?,
                required_f64(args, "x")?,
                required_f64(args, "y")?,
            )?;
            json!({ "moved": true, "desktopX": x, "desktopY": y, "frameInvalidated": true })
        }
        // 硬安全约束：本工具的真实桌面副作用（点击）不可逆，必须逐次用户确认。
        // 详见 ALWAYS_CONFIRM_TOOLS；不要在此处改为按权限模式跳过 approve。
        "computer_click" => {
            let frame_id = required_str(args, "frameId")?;
            let _action_guard =
                enter_action(&session, &action_token, AutomationMode::ComputerUse).await?;
            let (x, y) = session.computer.lock().unwrap().click(
                frame_id,
                required_f64(args, "x")?,
                required_f64(args, "y")?,
                optional_str(args, "button")?.unwrap_or("left"),
                optional_u64(args, "clickCount")?.unwrap_or(1) as u32,
            )?;
            json!({ "clicked": true, "desktopX": x, "desktopY": y, "frameInvalidated": true })
        }
        // 硬安全约束：拖动可能移动文件 / 改变顺序，必须逐次确认。
        // 详见 ALWAYS_CONFIRM_TOOLS。
        "computer_drag" => {
            let frame_id = required_str(args, "frameId")?;
            let _action_guard =
                enter_action(&session, &action_token, AutomationMode::ComputerUse).await?;
            session.computer.lock().unwrap().drag(
                frame_id,
                required_f64(args, "fromX")?,
                required_f64(args, "fromY")?,
                required_f64(args, "toX")?,
                required_f64(args, "toY")?,
                optional_u64(args, "durationMs")?.unwrap_or(500),
            )?;
            json!({ "dragged": true, "frameInvalidated": true })
        }
        "computer_scroll" => {
            let _action_guard =
                enter_action(&session, &action_token, AutomationMode::ComputerUse).await?;
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
        // 硬安全约束：键盘输入可能被当前应用立即读取/发送/提交，必须逐次确认。
        // 详见 ALWAYS_CONFIRM_TOOLS。
        "computer_type" => {
            let frame_id = required_str(args, "frameId")?;
            let characters = required_str(args, "text")?.chars().count();
            let _action_guard =
                enter_action(&session, &action_token, AutomationMode::ComputerUse).await?;
            session
                .computer
                .lock()
                .unwrap()
                .type_text(frame_id, required_str(args, "text")?)?;
            json!({ "typed": true, "characters": characters, "frameInvalidated": true })
        }
        // 硬安全约束：按键或快捷键可能提交内容/执行命令/改变应用状态，必须逐次确认。
        // 详见 ALWAYS_CONFIRM_TOOLS。
        "computer_key" => {
            let frame_id = required_str(args, "frameId")?;
            let key = required_str(args, "key")?;
            let modifiers = optional_string_array(args, "modifiers", 4)?;
            let _action_guard =
                enter_action(&session, &action_token, AutomationMode::ComputerUse).await?;
            session
                .computer
                .lock()
                .unwrap()
                .key(frame_id, key, &modifiers)?;
            json!({ "pressed": key, "modifiers": modifiers, "frameInvalidated": true })
        }
        "computer_wait" => {
            let milliseconds = optional_u64(args, "milliseconds")?
                .unwrap_or(1_000)
                .clamp(50, 30_000);
            tokio::select! {
                _ = action_token.cancelled() => {
                    return Err("自动化已暂停，等待操作已取消".into());
                }
                _ = tokio::time::sleep(Duration::from_millis(milliseconds)) => {}
            }
            let _action_guard =
                enter_action(&session, &action_token, AutomationMode::ComputerUse).await?;
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
            return Err("为防止本地数据泄露，操作网页时只允许上传当前任务工作区内的文件".into());
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
    tauri::async_runtime::spawn(async move {
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
    fn listener_registration_from_sync_context_uses_tauri_runtime() {
        let listener = bind_loopback().expect("bind loopback listener");
        let (result_tx, result_rx) = std::sync::mpsc::sync_channel(1);

        tauri::async_runtime::spawn(async move {
            let result = to_tokio_listener(listener)
                .await
                .and_then(|listener| listener.local_addr());
            let _ = result_tx.send(result);
        });

        let address = result_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("Tauri runtime should poll listener registration")
            .expect("listener registration should succeed");
        assert!(address.ip().is_loopback());
    }

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
        assert!(!tools.iter().any(|tool| tool["name"] == "automation_resume"));
        for tool_name in ["computer_click", "computer_type", "computer_key"] {
            let tool = tools.iter().find(|tool| tool["name"] == tool_name).unwrap();
            let properties = tool["inputSchema"]["properties"].as_object().unwrap();
            assert!(!properties.contains_key("consequential"));
            assert!(!properties.contains_key("sensitive"));
            assert!(!properties.contains_key("intent"));
        }
    }

    #[test]
    fn session_ids_reject_control_characters() {
        assert!(validate_session_id("session-1").is_ok());
        assert!(validate_session_id("bad\nvalue").is_err());
    }

    #[test]
    fn requires_independent_confirmation_matches_const_list() {
        for tool in super::ALWAYS_CONFIRM_TOOLS {
            assert!(
                super::requires_independent_confirmation(tool),
                "expected always-confirm for {tool}"
            );
        }
        for tool in [
            "computer_capabilities",
            "computer_displays",
            "computer_screenshot",
            "computer_move",
            "computer_scroll",
            "computer_wait",
            "browser_click",
            "browser_navigate",
        ] {
            assert!(
                !super::requires_independent_confirmation(tool),
                "expected NOT always-confirm for {tool}"
            );
        }
    }
}
