//! OpenAI Codex App Server integration.
//!
//! The App Server owns ChatGPT OAuth credentials and Codex conversation
//! persistence. EchoAgent only stores non-secret connection metadata so the
//! existing provider/model UI can present the account as a normal personal
//! connection without copying tokens into `config.toml`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use chrono::{TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

use crate::bridge::{PermissionFrontend, PermissionOptionFrontend, PermissionOutcome, Permissions};
use crate::providers::{ModelEntry, ModelProviderEntry};
use crate::sessions::SessionSummary;

pub const PROVIDER_ID: &str = "codex-chatgpt";
pub const PROVIDER_KIND: &str = "codex_chatgpt";
const SESSION_PREFIX: &str = "codex:";
const CONNECTION_STATE_VERSION: u32 = 1;
const MAX_STATE_BYTES: u64 = 512 * 1024;
const MAX_MODELS: usize = 128;
const MAX_THREADS: usize = 1_000;
const RPC_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45);

type RpcReply = Result<Value, String>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModel {
    pub id: String,
    pub display_name: String,
    #[serde(default)]
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionMetadata {
    version: u32,
    enabled: bool,
    label: String,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    plan_type: Option<String>,
    #[serde(default)]
    models: Vec<CodexModel>,
    #[serde(default)]
    rate_limits: Option<Value>,
    synced_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAccountStatus {
    pub available: bool,
    pub connected: bool,
    pub logged_in: bool,
    pub email: Option<String>,
    pub plan_type: Option<String>,
    pub models: Vec<CodexModel>,
    pub rate_limits: Option<Value>,
    pub synced_at: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexLoginStartResult {
    pub login_id: String,
    pub auth_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexConnectResult {
    pub provider_id: String,
    pub model_ids: Vec<String>,
}

#[derive(Debug)]
struct PendingRpc {
    generation: u64,
    sender: oneshot::Sender<RpcReply>,
}

#[derive(Debug, Default)]
struct RuntimeData {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    generation: u64,
    initialized: bool,
}

#[derive(Debug)]
struct CodexInner {
    runtime: Mutex<RuntimeData>,
    start_lock: Mutex<()>,
    pending: Mutex<HashMap<u64, PendingRpc>>,
    next_id: AtomicU64,
    next_generation: AtomicU64,
    active_turns: Mutex<HashMap<String, String>>,
    session_models: Mutex<HashMap<String, String>>,
    item_outputs: Mutex<HashMap<String, String>>,
    streamed_agent_items: Mutex<HashSet<String>>,
}

impl Default for CodexInner {
    fn default() -> Self {
        Self {
            runtime: Mutex::new(RuntimeData::default()),
            start_lock: Mutex::new(()),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            next_generation: AtomicU64::new(1),
            active_turns: Mutex::new(HashMap::new()),
            session_models: Mutex::new(HashMap::new()),
            item_outputs: Mutex::new(HashMap::new()),
            streamed_agent_items: Mutex::new(HashSet::new()),
        }
    }
}

#[derive(Clone, Default)]
pub struct CodexAppServer {
    inner: Arc<CodexInner>,
}

fn connection_state_path() -> PathBuf {
    crate::paths::echo_agent_home_dir().join("codex-chatgpt-connection.json")
}

fn codex_home_dir() -> PathBuf {
    crate::paths::echo_agent_home_dir().join("codex-runtime")
}

fn prepare_codex_home() -> Result<PathBuf, String> {
    let path = codex_home_dir();
    std::fs::create_dir_all(&path)
        .map_err(|error| format!("创建 Codex 私有数据目录失败：{error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("保护 Codex 私有数据目录失败：{error}"))?;
    }
    Ok(path)
}

fn read_connection_metadata() -> Option<ConnectionMetadata> {
    let path = connection_state_path();
    let bytes = crate::shell_fs::read_regular_file_bounded(&path, MAX_STATE_BYTES).ok()?;
    let mut metadata: ConnectionMetadata = serde_json::from_slice(&bytes).ok()?;
    if metadata.version != CONNECTION_STATE_VERSION || !metadata.enabled {
        return None;
    }
    metadata.models.retain(|model| valid_model_id(&model.id));
    metadata.models.truncate(MAX_MODELS);
    Some(metadata)
}

fn write_connection_metadata(metadata: &ConnectionMetadata) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(metadata)
        .map_err(|error| format!("序列化 Codex 连接信息失败：{error}"))?;
    crate::paths::write_private_file(&connection_state_path(), &bytes)
}

fn remove_connection_metadata() -> Result<(), String> {
    let path = connection_state_path();
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("删除 Codex 连接信息失败：{error}")),
    }
}

fn valid_model_id(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.chars().count() <= 256
        && !value.chars().any(char::is_control)
        && !value.contains('/')
}

pub fn is_codex_model(model_id: &str) -> bool {
    model_id.strip_prefix("codex/").is_some_and(valid_model_id)
}

pub fn remote_model_id(model_id: &str) -> Option<&str> {
    let remote = model_id.strip_prefix("codex/")?;
    valid_model_id(remote).then_some(remote)
}

pub fn is_codex_session(session_id: &str) -> bool {
    session_id
        .strip_prefix(SESSION_PREFIX)
        .is_some_and(|value| {
            !value.is_empty()
                && value.chars().count() <= 128
                && !value.chars().any(char::is_control)
        })
}

fn thread_id(session_id: &str) -> Result<&str, String> {
    session_id
        .strip_prefix(SESSION_PREFIX)
        .filter(|value| {
            !value.is_empty()
                && value.chars().count() <= 128
                && !value.chars().any(char::is_control)
        })
        .ok_or_else(|| "Codex 会话 ID 无效".to_string())
}

fn normalized_connection_label(label: Option<String>) -> String {
    let label = label
        .unwrap_or_default()
        .trim()
        .chars()
        .filter(|character| !character.is_control())
        .take(128)
        .collect::<String>();
    if label.is_empty() {
        "ChatGPT".into()
    } else {
        label
    }
}

fn session_id(thread_id: &str) -> String {
    format!("{SESSION_PREFIX}{thread_id}")
}

pub fn configured_model_ids() -> Vec<String> {
    read_connection_metadata()
        .map(|metadata| {
            metadata
                .models
                .into_iter()
                .map(|model| format!("codex/{}", model.id))
                .collect()
        })
        .unwrap_or_default()
}

pub fn catalog_entries() -> Option<(ModelProviderEntry, Vec<ModelEntry>)> {
    let metadata = read_connection_metadata()?;
    let provider = ModelProviderEntry {
        id: PROVIDER_ID.into(),
        provider_kind: PROVIDER_KIND.into(),
        label: Some(if metadata.label.trim().is_empty() {
            "ChatGPT".into()
        } else {
            metadata.label.clone()
        }),
        api_key: None,
        base_url: None,
        api_backend: None,
        auth_scheme: None,
        context_window: None,
        source: "personal".into(),
        managed: false,
        credential_configured: true,
        synced_at: Some(metadata.synced_at),
        organization_provider: None,
        account_email: metadata.email,
        plan_type: metadata.plan_type,
        rate_limits: metadata.rate_limits,
    };
    let models = metadata
        .models
        .into_iter()
        .map(|model| ModelEntry {
            model_id: format!("codex/{}", model.id),
            remote_model_id: Some(model.id),
            provider_id: PROVIDER_ID.into(),
            name: Some(model.display_name),
            context_window: None,
            managed: true,
        })
        .collect();
    Some((provider, models))
}

fn executable_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("ECHO_AGENT_CODEX_BIN") {
        candidates.push(PathBuf::from(path));
    }
    if let Ok(current) = std::env::current_exe() {
        if let Some(parent) = current.parent() {
            candidates.push(parent.join(if cfg!(windows) { "codex.exe" } else { "codex" }));
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join(if cfg!(windows) { "codex.exe" } else { "codex" }));
    }
    if let Some(target) = bundled_target() {
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("binaries")
                .join(if cfg!(windows) {
                    format!("codex-{target}.exe")
                } else {
                    format!("codex-{target}")
                }),
        );
    }
    candidates.push(PathBuf::from(if cfg!(windows) {
        "codex.exe"
    } else {
        "codex"
    }));
    candidates
}

fn bundled_target() -> Option<&'static str> {
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    return Some("x86_64-apple-darwin");
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return Some("aarch64-apple-darwin");
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return Some("x86_64-unknown-linux-musl");
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    return Some("aarch64-unknown-linux-musl");
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return Some("x86_64-pc-windows-msvc");
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    return Some("aarch64-pc-windows-msvc");
    #[allow(unreachable_code)]
    None
}

impl CodexAppServer {
    async fn ensure_started(
        &self,
        app: &AppHandle,
        permissions: Permissions,
    ) -> Result<(), String> {
        if self.inner.runtime.lock().await.initialized {
            return Ok(());
        }
        let _guard = self.inner.start_lock.lock().await;
        if self.inner.runtime.lock().await.initialized {
            return Ok(());
        }

        // Keep EchoAgent's ChatGPT session isolated from a separately installed
        // Codex CLI. Removing this connection must never log that CLI out.
        let codex_home = prepare_codex_home()?;
        let mut last_error = None;
        let mut spawned = None;
        for candidate in executable_candidates(app) {
            let mut command = Command::new(&candidate);
            command
                .arg("app-server")
                .env("CODEX_HOME", &codex_home)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            match command.spawn() {
                Ok(child) => {
                    spawned = Some(child);
                    break;
                }
                Err(error) => last_error = Some(format!("{}: {error}", candidate.display())),
            }
        }
        let mut child = spawned.ok_or_else(|| {
            format!(
                "未找到可用的 Codex Runtime。{}",
                last_error
                    .map(|error| format!("最近一次启动失败：{error}"))
                    .unwrap_or_default()
            )
        })?;
        let stdin = child.stdin.take().ok_or("Codex Runtime 未提供标准输入")?;
        let stdout = child.stdout.take().ok_or("Codex Runtime 未提供标准输出")?;
        let stderr = child.stderr.take();
        let generation = self.inner.next_generation.fetch_add(1, Ordering::Relaxed);
        {
            let mut runtime = self.inner.runtime.lock().await;
            runtime.stdin = Some(stdin);
            runtime.child = Some(child);
            runtime.generation = generation;
            runtime.initialized = false;
        }

        let reader_inner = self.inner.clone();
        let reader_app = app.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        if line.len() > 8 * 1024 * 1024 {
                            tracing::warn!("discarding oversized Codex App Server message");
                            continue;
                        }
                        match serde_json::from_str::<Value>(&line) {
                            Ok(message) => {
                                handle_message(
                                    reader_inner.clone(),
                                    reader_app.clone(),
                                    permissions.clone(),
                                    message,
                                )
                                .await;
                            }
                            Err(error) => tracing::warn!(%error, "invalid Codex App Server JSON"),
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        tracing::warn!(%error, "Codex App Server stdout failed");
                        break;
                    }
                }
            }
            let mut pending = reader_inner.pending.lock().await;
            let stopped_ids = pending
                .iter()
                .filter_map(|(id, request)| (request.generation == generation).then_some(*id))
                .collect::<Vec<_>>();
            for id in stopped_ids {
                if let Some(request) = pending.remove(&id) {
                    let _ = request.sender.send(Err("Codex Runtime 已停止".into()));
                }
            }
            drop(pending);
            let mut runtime = reader_inner.runtime.lock().await;
            if runtime.generation == generation {
                runtime.stdin.take();
                runtime.child.take();
                runtime.initialized = false;
                let _ = reader_app.emit(
                    "codex://runtime-stopped",
                    json!({ "reason": "Codex Runtime 已停止，下次操作将自动重启。" }),
                );
            }
        });

        if let Some(stderr) = stderr {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::debug!(target: "codex_app_server", "{}", line.chars().take(4_096).collect::<String>());
                }
            });
        }

        let initialized = self
            .rpc(
                "initialize",
                json!({
                    "clientInfo": {
                        "name": "echoagent",
                        "title": "EchoAgent",
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "capabilities": { "experimentalApi": true }
                }),
            )
            .await;
        if let Err(error) = initialized {
            self.stop().await;
            return Err(format!("Codex Runtime 初始化失败：{error}"));
        }
        if let Err(error) = self.notify("initialized", None).await {
            self.stop().await;
            return Err(format!("Codex Runtime 初始化确认失败：{error}"));
        }
        let mut runtime = self.inner.runtime.lock().await;
        if runtime.generation != generation || runtime.stdin.is_none() {
            return Err("Codex Runtime 在初始化期间已停止".into());
        }
        runtime.initialized = true;
        Ok(())
    }

    async fn write_message(&self, message: &Value) -> Result<(), String> {
        let mut encoded = serde_json::to_vec(message)
            .map_err(|error| format!("序列化 Codex 请求失败：{error}"))?;
        encoded.push(b'\n');
        let mut runtime = self.inner.runtime.lock().await;
        let stdin = runtime.stdin.as_mut().ok_or("Codex Runtime 未启动")?;
        stdin
            .write_all(&encoded)
            .await
            .map_err(|error| format!("写入 Codex Runtime 失败：{error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("刷新 Codex Runtime 请求失败：{error}"))
    }

    async fn rpc(&self, method: &str, params: Value) -> RpcReply {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let generation = self.inner.runtime.lock().await.generation;
        let (sender, receiver) = oneshot::channel();
        self.inner
            .pending
            .lock()
            .await
            .insert(id, PendingRpc { generation, sender });
        if let Err(error) = self
            .write_message(&json!({ "id": id, "method": method, "params": params }))
            .await
        {
            self.inner.pending.lock().await.remove(&id);
            return Err(error);
        }
        match tokio::time::timeout(RPC_TIMEOUT, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(format!("Codex Runtime 请求被意外终止：{method}")),
            Err(_) => {
                self.inner.pending.lock().await.remove(&id);
                Err(format!("Codex Runtime 请求超时：{method}"))
            }
        }
    }

    async fn request(
        &self,
        app: &AppHandle,
        permissions: Permissions,
        method: &str,
        params: Value,
    ) -> RpcReply {
        self.ensure_started(app, permissions).await?;
        self.rpc(method, params).await
    }

    async fn notify(&self, method: &str, params: Option<Value>) -> Result<(), String> {
        let message = match params {
            Some(params) => json!({ "method": method, "params": params }),
            None => json!({ "method": method }),
        };
        self.write_message(&message).await
    }

    async fn stop(&self) {
        let mut runtime = self.inner.runtime.lock().await;
        runtime.initialized = false;
        runtime.stdin.take();
        if let Some(mut child) = runtime.child.take() {
            let _ = child.kill().await;
        }
    }

    async fn account_value(&self, app: &AppHandle, permissions: Permissions) -> RpcReply {
        self.request(
            app,
            permissions,
            "account/read",
            json!({ "refreshToken": false }),
        )
        .await
    }

    async fn fetch_models(
        &self,
        app: &AppHandle,
        permissions: Permissions,
    ) -> Result<Vec<CodexModel>, String> {
        let response = self
            .request(
                app,
                permissions,
                "model/list",
                json!({ "limit": MAX_MODELS, "includeHidden": false }),
            )
            .await?;
        let mut models = Vec::new();
        for entry in response
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .take(MAX_MODELS)
        {
            if entry.get("hidden").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let Some(id) = entry
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| valid_model_id(id))
            else {
                continue;
            };
            let display_name = entry
                .get("displayName")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(id)
                .chars()
                .take(256)
                .collect();
            models.push(CodexModel {
                id: id.to_string(),
                display_name,
                is_default: entry
                    .get("isDefault")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            });
        }
        if models.is_empty() {
            return Err("当前 ChatGPT 账号没有返回可用的 Codex 模型".into());
        }
        Ok(models)
    }

    async fn fetch_rate_limits(&self, app: &AppHandle, permissions: Permissions) -> Option<Value> {
        self.request(app, permissions, "account/rateLimits/read", json!({}))
            .await
            .ok()
            .and_then(|value| value.get("rateLimits").cloned())
    }

    pub async fn new_thread(
        &self,
        app: &AppHandle,
        permissions: Permissions,
        cwd: &Path,
        model: &str,
    ) -> Result<String, String> {
        let response = self
            .request(
                app,
                permissions,
                "thread/start",
                json!({
                    "cwd": cwd,
                    "model": model,
                    "approvalPolicy": approval_policy(),
                    "sandbox": "workspace-write",
                    "serviceName": "EchoAgent"
                }),
            )
            .await?;
        let id = response
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .ok_or("Codex Runtime 未返回会话 ID")?;
        let sid = session_id(id);
        self.inner
            .session_models
            .lock()
            .await
            .insert(id.to_string(), model.to_string());
        Ok(sid)
    }

    pub async fn resume_thread(
        &self,
        app: &AppHandle,
        permissions: Permissions,
        session: &str,
        cwd: &Path,
    ) -> Result<(), String> {
        let tid = thread_id(session)?;
        let response = self
            .request(
                app,
                permissions,
                "thread/resume",
                json!({
                    "threadId": tid,
                    "cwd": cwd,
                    "approvalPolicy": approval_policy(),
                    "sandbox": "workspace-write"
                }),
            )
            .await?;
        if let Some(model) = response.get("model").and_then(Value::as_str) {
            self.inner
                .session_models
                .lock()
                .await
                .insert(tid.to_string(), model.to_string());
        }
        if let Some(turns) = response.pointer("/thread/turns").and_then(Value::as_array) {
            for turn in turns {
                if let Some(items) = turn.get("items").and_then(Value::as_array) {
                    for item in items {
                        emit_history_item(app, tid, item);
                    }
                }
                let prompt_id = turn.get("id").and_then(Value::as_str).unwrap_or("history");
                let _ = app.emit(
                    "agent://complete",
                    json!({
                        "sessionId": session_id(tid),
                        "promptId": prompt_id,
                        "stopReason": "end_turn"
                    }),
                );
            }
        }
        Ok(())
    }

    pub async fn send(
        &self,
        app: &AppHandle,
        permissions: Permissions,
        session: &str,
        text: &str,
        attachments: &[String],
    ) -> Result<(), String> {
        let tid = thread_id(session)?;
        let model = self.inner.session_models.lock().await.get(tid).cloned();
        let mut input = Vec::with_capacity(1 + attachments.len());
        if !text.is_empty() {
            input.push(json!({ "type": "text", "text": text }));
        }
        for path in attachments {
            input.push(json!({ "type": "localImage", "path": path }));
        }
        let response = self
            .request(
                app,
                permissions,
                "turn/start",
                json!({
                    "threadId": tid,
                    "input": input,
                    "model": model,
                    "approvalPolicy": approval_policy(),
                    "sandboxPolicy": {
                        "type": "workspaceWrite",
                        "writableRoots": [],
                        "networkAccess": false
                    }
                }),
            )
            .await?;
        if let Some(turn_id) = response.pointer("/turn/id").and_then(Value::as_str) {
            self.inner
                .active_turns
                .lock()
                .await
                .insert(tid.to_string(), turn_id.to_string());
        }
        Ok(())
    }

    pub async fn cancel(
        &self,
        app: &AppHandle,
        permissions: Permissions,
        session: &str,
    ) -> Result<(), String> {
        let tid = thread_id(session)?;
        let turn_id = self
            .inner
            .active_turns
            .lock()
            .await
            .get(tid)
            .cloned()
            .ok_or("当前 Codex 会话没有正在执行的任务")?;
        self.request(
            app,
            permissions,
            "turn/interrupt",
            json!({ "threadId": tid, "turnId": turn_id }),
        )
        .await?;
        Ok(())
    }

    pub async fn set_model(&self, session: &str, local_model_id: &str) -> Result<(), String> {
        let tid = thread_id(session)?;
        let remote = remote_model_id(local_model_id).ok_or(
            "MODEL_SWITCH_INCOMPATIBLE_AGENT：Codex 会话只能切换到 ChatGPT 连接下的模型，请新建对话以使用其他连接。",
        )?;
        self.inner
            .session_models
            .lock()
            .await
            .insert(tid.to_string(), remote.to_string());
        Ok(())
    }

    pub async fn rename_thread(
        &self,
        app: &AppHandle,
        permissions: Permissions,
        session: &str,
        title: &str,
    ) -> Result<(), String> {
        self.request(
            app,
            permissions,
            "thread/name/set",
            json!({ "threadId": thread_id(session)?, "name": title }),
        )
        .await?;
        Ok(())
    }

    pub async fn delete_thread(
        &self,
        app: &AppHandle,
        permissions: Permissions,
        session: &str,
    ) -> Result<(), String> {
        let tid = thread_id(session)?;
        self.request(
            app,
            permissions,
            "thread/delete",
            json!({ "threadId": tid }),
        )
        .await?;
        self.inner.active_turns.lock().await.remove(tid);
        self.inner.session_models.lock().await.remove(tid);
        Ok(())
    }

    pub async fn set_archived(
        &self,
        app: &AppHandle,
        permissions: Permissions,
        session: &str,
        archived: bool,
    ) -> Result<(), String> {
        let method = if archived {
            "thread/archive"
        } else {
            "thread/unarchive"
        };
        self.request(
            app,
            permissions,
            method,
            json!({ "threadId": thread_id(session)? }),
        )
        .await?;
        Ok(())
    }

    pub async fn list_threads(
        &self,
        app: &AppHandle,
        permissions: Permissions,
        cwd: Option<&str>,
        include_archived: bool,
    ) -> Result<Vec<SessionSummary>, String> {
        if read_connection_metadata().is_none() {
            return Ok(Vec::new());
        }
        let mut out = self
            .list_threads_page(app, permissions.clone(), cwd, false)
            .await?;
        if include_archived {
            out.extend(self.list_threads_page(app, permissions, cwd, true).await?);
        }
        out.truncate(MAX_THREADS);
        Ok(out)
    }

    async fn list_threads_page(
        &self,
        app: &AppHandle,
        permissions: Permissions,
        cwd: Option<&str>,
        archived: bool,
    ) -> Result<Vec<SessionSummary>, String> {
        let response = self
            .request(
                app,
                permissions,
                "thread/list",
                json!({
                    "limit": MAX_THREADS,
                    "cwd": cwd,
                    "archived": archived,
                    "sortKey": "updated_at",
                    "sortDirection": "desc",
                    "sourceKinds": ["appServer"]
                }),
            )
            .await?;
        let mut out = Vec::new();
        for thread in response
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .take(MAX_THREADS)
        {
            let Some(id) = thread.get("id").and_then(Value::as_str) else {
                continue;
            };
            let Some(thread_cwd) = thread.get("cwd").and_then(Value::as_str) else {
                continue;
            };
            let title = thread
                .get("name")
                .and_then(Value::as_str)
                .or_else(|| thread.get("preview").and_then(Value::as_str))
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("新的对话")
                .chars()
                .take(512)
                .collect();
            let updated_at = thread
                .get("updatedAt")
                .and_then(Value::as_i64)
                .and_then(|seconds| Utc.timestamp_opt(seconds, 0).single())
                .map(|value| value.to_rfc3339());
            let current_model_id = thread
                .get("model")
                .and_then(Value::as_str)
                .filter(|model| valid_model_id(model))
                .map(|model| format!("codex/{model}"));
            out.push(SessionSummary {
                session_id: session_id(id),
                title,
                updated_at,
                cwd: thread_cwd.to_string(),
                is_git_repo: None,
                pinned: None,
                archived: Some(archived),
                current_model_id,
                expert_id: None,
                expert_name: None,
                expert_avatar: None,
            });
        }
        Ok(out)
    }
}

fn approval_policy() -> &'static str {
    match crate::permission_config::read_permission_mode().as_str() {
        "always-approve" => "never",
        _ => "on-request",
    }
}

async fn handle_message(
    inner: Arc<CodexInner>,
    app: AppHandle,
    permissions: Permissions,
    message: Value,
) {
    if let Some(id) = message.get("id").and_then(Value::as_u64) {
        if message.get("method").is_none() {
            if let Some(pending) = inner.pending.lock().await.remove(&id) {
                let result = if let Some(error) = message.get("error") {
                    let detail = error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("未知 Codex Runtime 错误");
                    Err(detail.to_string())
                } else {
                    Ok(message.get("result").cloned().unwrap_or(Value::Null))
                };
                let _ = pending.sender.send(result);
            }
            return;
        }
    }
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return;
    };
    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
    if let Some(request_id) = message.get("id").cloned() {
        handle_server_request(inner, app, permissions, request_id, method, params).await;
    } else {
        handle_notification(inner, app, method, params).await;
    }
}

async fn write_inner(inner: &CodexInner, message: Value) -> Result<(), String> {
    let mut encoded = serde_json::to_vec(&message).map_err(|error| error.to_string())?;
    encoded.push(b'\n');
    let mut runtime = inner.runtime.lock().await;
    let stdin = runtime.stdin.as_mut().ok_or("Codex Runtime 未启动")?;
    stdin
        .write_all(&encoded)
        .await
        .map_err(|error| error.to_string())?;
    stdin.flush().await.map_err(|error| error.to_string())
}

async fn handle_server_request(
    inner: Arc<CodexInner>,
    app: AppHandle,
    permissions: Permissions,
    rpc_id: Value,
    method: &str,
    params: Value,
) {
    if !matches!(
        method,
        "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval"
    ) {
        let _ = write_inner(
            &inner,
            json!({ "id": rpc_id, "error": { "code": -32601, "message": "unsupported request" } }),
        )
        .await;
        return;
    }
    let tid = params
        .get("threadId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let item_id = params
        .get("itemId")
        .and_then(Value::as_str)
        .unwrap_or("codex-item");
    let request_id = format!(
        "codex-approval-{}",
        inner.next_id.fetch_add(1, Ordering::Relaxed)
    );
    let is_command = method.contains("commandExecution");
    let is_permission_profile = method == "item/permissions/requestApproval";
    let title = params
        .get("reason")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            params
                .get("command")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| {
            if is_command {
                "执行命令".into()
            } else if is_permission_profile {
                "授予额外运行权限".into()
            } else {
                "修改文件".into()
            }
        });
    let raw_input = if is_command {
        Some(json!({
            "command": params.get("command"),
            "cwd": params.get("cwd"),
            "reason": params.get("reason")
        }))
    } else if is_permission_profile {
        Some(json!({
            "cwd": params.get("cwd"),
            "reason": params.get("reason"),
            "permissions": params.get("permissions")
        }))
    } else {
        Some(json!({
            "reason": params.get("reason"),
            "grantRoot": params.get("grantRoot")
        }))
    };
    let request = PermissionFrontend {
        request_id: request_id.clone(),
        session_id: session_id(tid),
        tool_call_id: item_id.to_string(),
        tool_kind: if is_command {
            "run_terminal_command".into()
        } else if is_permission_profile {
            "other".into()
        } else {
            "edit".into()
        },
        title: title.chars().take(512).collect(),
        raw_input,
        options: vec![
            PermissionOptionFrontend {
                option_id: "codex-accept".into(),
                kind: "allow".into(),
                title: "允许一次".into(),
            },
            PermissionOptionFrontend {
                option_id: "codex-accept-session".into(),
                kind: "allow_always".into(),
                title: "本次会话始终允许".into(),
            },
            PermissionOptionFrontend {
                option_id: "codex-decline".into(),
                kind: "deny".into(),
                title: "拒绝".into(),
            },
        ],
    };
    let requested_permissions = params
        .get("permissions")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let Ok(receiver) = permissions.register(request.clone()).await else {
        let result = if is_permission_profile {
            json!({ "permissions": {}, "scope": "turn" })
        } else {
            json!({ "decision": "cancel" })
        };
        let _ = write_inner(&inner, json!({ "id": rpc_id, "result": result })).await;
        return;
    };
    if app.emit("agent://permission", request).is_err() {
        let _ = permissions
            .resolve(&request_id, PermissionOutcome::Cancelled)
            .await;
    }
    tokio::spawn(async move {
        let outcome = receiver.await;
        let result = if is_permission_profile {
            match outcome {
                Ok(PermissionOutcome::Selected(option)) if option == "codex-accept" => {
                    json!({ "permissions": requested_permissions, "scope": "turn" })
                }
                Ok(PermissionOutcome::Selected(option)) if option == "codex-accept-session" => {
                    json!({ "permissions": requested_permissions, "scope": "session" })
                }
                _ => json!({ "permissions": {}, "scope": "turn" }),
            }
        } else {
            let decision = match outcome {
                Ok(PermissionOutcome::Selected(option)) if option == "codex-accept" => "accept",
                Ok(PermissionOutcome::Selected(option)) if option == "codex-accept-session" => {
                    "acceptForSession"
                }
                Ok(PermissionOutcome::Selected(_)) => "decline",
                Ok(PermissionOutcome::Cancelled) | Err(_) => "cancel",
            };
            json!({ "decision": decision })
        };
        let _ = write_inner(&inner, json!({ "id": rpc_id, "result": result })).await;
    });
}

async fn handle_notification(inner: Arc<CodexInner>, app: AppHandle, method: &str, params: Value) {
    match method {
        "account/login/completed" | "account/updated" | "account/rateLimits/updated" => {
            let _ = app.emit("codex://auth-changed", params);
        }
        "item/agentMessage/delta" => {
            if let (Some(tid), Some(item_id), Some(delta)) = (
                params.get("threadId").and_then(Value::as_str),
                params.get("itemId").and_then(Value::as_str),
                params.get("delta").and_then(Value::as_str),
            ) {
                inner
                    .streamed_agent_items
                    .lock()
                    .await
                    .insert(item_id.to_string());
                emit_text_update(&app, tid, "agent_message_chunk", "text", delta);
            }
        }
        "item/reasoning/textDelta" | "item/reasoning/summaryTextDelta" => {
            if let (Some(tid), Some(delta)) = (
                params.get("threadId").and_then(Value::as_str),
                params.get("delta").and_then(Value::as_str),
            ) {
                emit_text_update(&app, tid, "agent_thought_chunk", "thought", delta);
            }
        }
        "item/commandExecution/outputDelta" | "item/commandExec/outputDelta" => {
            if let (Some(tid), Some(item_id), Some(delta)) = (
                params.get("threadId").and_then(Value::as_str),
                params.get("itemId").and_then(Value::as_str),
                params.get("delta").and_then(Value::as_str),
            ) {
                let output = {
                    let mut outputs = inner.item_outputs.lock().await;
                    let output = outputs.entry(item_id.to_string()).or_default();
                    if output.len() < 4 * 1024 * 1024 {
                        output.push_str(delta);
                    }
                    output.clone()
                };
                emit_tool_update(
                    &app,
                    tid,
                    item_id,
                    json!([{
                        "type": "command_output",
                        "output": output
                    }]),
                );
            }
        }
        "item/started" => {
            if let (Some(tid), Some(item)) = (
                params.get("threadId").and_then(Value::as_str),
                params.get("item"),
            ) {
                emit_live_item(&app, tid, item, false, &inner).await;
            }
        }
        "item/completed" => {
            if let (Some(tid), Some(item)) = (
                params.get("threadId").and_then(Value::as_str),
                params.get("item"),
            ) {
                emit_live_item(&app, tid, item, true, &inner).await;
            }
        }
        "turn/completed" => {
            if let (Some(tid), Some(turn)) = (
                params.get("threadId").and_then(Value::as_str),
                params.get("turn"),
            ) {
                inner.active_turns.lock().await.remove(tid);
                let turn_id = turn
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("codex-turn");
                let status = turn
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("completed");
                let error = turn
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let stop_reason = match status {
                    "interrupted" => "cancelled",
                    "failed" => "error",
                    _ => "end_turn",
                };
                if status == "failed" {
                    let _ = app.emit(
                        "agent://turn-error",
                        json!({ "sessionId": session_id(tid), "kind": "error", "detail": error }),
                    );
                }
                let _ = app.emit(
                    "agent://complete",
                    json!({
                        "sessionId": session_id(tid),
                        "promptId": turn_id,
                        "stopReason": stop_reason,
                        "agentResult": error
                    }),
                );
            }
        }
        "thread/name/updated" => {
            if let (Some(tid), Some(name)) = (
                params.get("threadId").and_then(Value::as_str),
                params.get("name").and_then(Value::as_str),
            ) {
                let _ = app.emit(
                    "agent://summary",
                    json!({ "sessionId": session_id(tid), "title": name }),
                );
            }
        }
        "error" if params.get("willRetry").and_then(Value::as_bool) == Some(false) => {
            if let Some(tid) = params.get("threadId").and_then(Value::as_str) {
                let detail = params
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("Codex 执行失败");
                let _ = app.emit(
                    "agent://turn-error",
                    json!({ "sessionId": session_id(tid), "kind": "error", "detail": detail }),
                );
            }
        }
        _ => {}
    }
}

fn emit_text_update(app: &AppHandle, tid: &str, update: &str, content_type: &str, text: &str) {
    if text.is_empty() {
        return;
    }
    let _ = app.emit(
        "agent://update",
        json!({
            "sessionId": session_id(tid),
            "sessionUpdate": update,
            "content": [{ "type": content_type, "text": text }]
        }),
    );
}

fn emit_tool_update(app: &AppHandle, tid: &str, item_id: &str, content: Value) {
    let _ = app.emit(
        "agent://update",
        json!({
            "sessionId": session_id(tid),
            "sessionUpdate": "tool_call_update",
            "toolCallId": item_id,
            "content": content
        }),
    );
}

async fn emit_live_item(
    app: &AppHandle,
    tid: &str,
    item: &Value,
    completed: bool,
    inner: &CodexInner,
) {
    let kind = item.get("type").and_then(Value::as_str).unwrap_or_default();
    if kind == "agentMessage" {
        let item_id = item.get("id").and_then(Value::as_str).unwrap_or_default();
        let streamed = inner.streamed_agent_items.lock().await.remove(item_id);
        if completed && !streamed {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
                emit_text_update(app, tid, "agent_message_chunk", "text", text);
            }
        }
        return;
    }
    emit_tool_item(app, tid, item, completed);
}

fn emit_history_item(app: &AppHandle, tid: &str, item: &Value) {
    match item.get("type").and_then(Value::as_str).unwrap_or_default() {
        "userMessage" => {
            let content = item.get("content").and_then(Value::as_array);
            let text = content
                .into_iter()
                .flatten()
                .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|entry| entry.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("");
            if !text.is_empty() {
                let _ = app.emit(
                    "agent://update",
                    json!({
                        "sessionId": session_id(tid),
                        "sessionUpdate": "user_message_chunk",
                        "content": [{ "type": "text", "text": text }]
                    }),
                );
            }
        }
        "agentMessage" => {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
                emit_text_update(app, tid, "agent_message_chunk", "text", text);
            }
        }
        "reasoning" => {
            let text = item
                .get("summary")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .chain(
                    item.get("content")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten(),
                )
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("\n");
            emit_text_update(app, tid, "agent_thought_chunk", "thought", &text);
        }
        _ => {
            // Session-store updates cannot create a missing tool card. Replaying
            // both events reconstructs completed historical tools correctly.
            emit_tool_item(app, tid, item, false);
            emit_tool_item(app, tid, item, true);
        }
    }
}

fn emit_tool_item(app: &AppHandle, tid: &str, item: &Value, completed: bool) {
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
    let item_id = item
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("codex-tool");
    let (title, tool_kind, raw_input, content) = match item_type {
        "commandExecution" => {
            let command = item
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let output = item
                .get("aggregatedOutput")
                .and_then(Value::as_str)
                .unwrap_or_default();
            (
                if command.is_empty() {
                    "执行命令".into()
                } else {
                    command.chars().take(256).collect()
                },
                "run_terminal_command",
                Some(json!({ "command": command, "cwd": item.get("cwd") })),
                json!([{ "type": "command_output", "command": command, "output": output, "exitCode": item.get("exitCode") }]),
            )
        }
        "fileChange" => (
            "修改文件".into(),
            "edit",
            Some(json!({ "changes": item.get("changes") })),
            json!([{ "type": "text", "text": item.get("changes").cloned().unwrap_or(Value::Null).to_string() }]),
        ),
        "mcpToolCall" => {
            let server = item.get("server").and_then(Value::as_str).unwrap_or("MCP");
            let tool = item.get("tool").and_then(Value::as_str).unwrap_or("工具");
            (
                format!("{server} · {tool}"),
                "other",
                item.get("arguments").cloned(),
                json!([{ "type": "text", "text": item.get("result").or_else(|| item.get("error")).cloned().unwrap_or(Value::Null).to_string() }]),
            )
        }
        "webSearch" => (
            format!(
                "网页搜索：{}",
                item.get("query")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            ),
            "web_search",
            item.get("query").cloned(),
            json!([]),
        ),
        _ => return,
    };
    let status = if completed {
        match item.get("status").and_then(Value::as_str) {
            Some("failed" | "declined" | "error") => "failed",
            _ => "completed",
        }
    } else {
        "in_progress"
    };
    let _ = app.emit(
        "agent://update",
        json!({
            "sessionId": session_id(tid),
            "sessionUpdate": if completed { "tool_call_update" } else { "tool_call" },
            "toolCallId": item_id,
            "title": title,
            "kind": tool_kind,
            "status": status,
            "rawInput": raw_input,
            "content": content
        }),
    );
}

fn account_fields(value: &Value) -> (bool, Option<String>, Option<String>) {
    let account = value.get("account");
    let logged_in = account
        .and_then(|account| account.get("type"))
        .and_then(Value::as_str)
        == Some("chatgpt");
    let email = account
        .and_then(|account| account.get("email"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let plan_type = account
        .and_then(|account| account.get("planType"))
        .and_then(Value::as_str)
        .map(str::to_string);
    (logged_in, email, plan_type)
}

#[tauri::command]
pub async fn codex_account_status(
    app: AppHandle,
    state: tauri::State<'_, CodexAppServer>,
    permissions: tauri::State<'_, Permissions>,
) -> Result<CodexAccountStatus, String> {
    let metadata = read_connection_metadata();
    match state.account_value(&app, permissions.share()).await {
        Ok(account) => {
            let (logged_in, email, plan_type) = account_fields(&account);
            Ok(CodexAccountStatus {
                available: true,
                connected: metadata.is_some(),
                logged_in,
                email: email.or_else(|| metadata.as_ref().and_then(|value| value.email.clone())),
                plan_type: plan_type
                    .or_else(|| metadata.as_ref().and_then(|value| value.plan_type.clone())),
                models: metadata
                    .as_ref()
                    .map(|value| value.models.clone())
                    .unwrap_or_default(),
                rate_limits: metadata
                    .as_ref()
                    .and_then(|value| value.rate_limits.clone()),
                synced_at: metadata.as_ref().map(|value| value.synced_at),
                error: None,
            })
        }
        Err(error) => Ok(CodexAccountStatus {
            available: false,
            connected: metadata.is_some(),
            logged_in: false,
            email: metadata.as_ref().and_then(|value| value.email.clone()),
            plan_type: metadata.as_ref().and_then(|value| value.plan_type.clone()),
            models: metadata
                .as_ref()
                .map(|value| value.models.clone())
                .unwrap_or_default(),
            rate_limits: metadata
                .as_ref()
                .and_then(|value| value.rate_limits.clone()),
            synced_at: metadata.as_ref().map(|value| value.synced_at),
            error: Some(error),
        }),
    }
}

#[tauri::command]
pub async fn codex_login_start(
    app: AppHandle,
    state: tauri::State<'_, CodexAppServer>,
    permissions: tauri::State<'_, Permissions>,
) -> Result<CodexLoginStartResult, String> {
    let response = state
        .request(
            &app,
            permissions.share(),
            "account/login/start",
            json!({
                "type": "chatgpt",
                "appBrand": "chatgpt",
                "useHostedLoginSuccessPage": true
            }),
        )
        .await?;
    let login_id = response
        .get("loginId")
        .and_then(Value::as_str)
        .ok_or("Codex Runtime 未返回登录 ID")?
        .to_string();
    let auth_url = response
        .get("authUrl")
        .and_then(Value::as_str)
        .ok_or("Codex Runtime 未返回登录地址")?
        .to_string();
    let parsed = url::Url::parse(&auth_url).map_err(|_| "Codex 登录地址无效")?;
    if parsed.scheme() != "https" {
        return Err("Codex 登录地址未使用 HTTPS".into());
    }
    if let Err(error) = open::that(&auth_url) {
        let _ = state
            .request(
                &app,
                permissions.share(),
                "account/login/cancel",
                json!({ "loginId": login_id }),
            )
            .await;
        return Err(format!("无法打开系统浏览器：{error}"));
    }
    Ok(CodexLoginStartResult { login_id, auth_url })
}

#[tauri::command]
pub async fn codex_login_cancel(
    app: AppHandle,
    state: tauri::State<'_, CodexAppServer>,
    permissions: tauri::State<'_, Permissions>,
    login_id: String,
) -> Result<(), String> {
    if login_id.trim().is_empty()
        || login_id.chars().count() > 256
        || login_id.chars().any(char::is_control)
    {
        return Err("Codex 登录 ID 无效".into());
    }
    state
        .request(
            &app,
            permissions.share(),
            "account/login/cancel",
            json!({ "loginId": login_id }),
        )
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn codex_connect(
    app: AppHandle,
    state: tauri::State<'_, CodexAppServer>,
    permissions: tauri::State<'_, Permissions>,
    label: Option<String>,
) -> Result<CodexConnectResult, String> {
    let permissions = permissions.share();
    let account = state.account_value(&app, permissions.clone()).await?;
    let (logged_in, email, plan_type) = account_fields(&account);
    if !logged_in {
        return Err("尚未完成 ChatGPT 登录".into());
    }
    let models = state.fetch_models(&app, permissions.clone()).await?;
    let rate_limits = state.fetch_rate_limits(&app, permissions).await;
    let synced_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let metadata = ConnectionMetadata {
        version: CONNECTION_STATE_VERSION,
        enabled: true,
        label: normalized_connection_label(label),
        email,
        plan_type,
        models: models.clone(),
        rate_limits,
        synced_at,
    };
    write_connection_metadata(&metadata)?;
    let model_ids = models
        .iter()
        .map(|model| format!("codex/{}", model.id))
        .collect::<Vec<_>>();
    let _ = app.emit(
        "agent://models-update",
        json!({ "source": "codex-chatgpt" }),
    );
    Ok(CodexConnectResult {
        provider_id: PROVIDER_ID.into(),
        model_ids,
    })
}

#[tauri::command]
pub async fn codex_logout(
    app: AppHandle,
    state: tauri::State<'_, CodexAppServer>,
    permissions: tauri::State<'_, Permissions>,
) -> Result<(), String> {
    state
        .request(&app, permissions.share(), "account/logout", json!({}))
        .await?;
    remove_connection_metadata()?;
    let _ = app.emit(
        "agent://models-update",
        json!({ "source": "codex-chatgpt" }),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_model_ids_are_namespaced_and_validated() {
        assert!(is_codex_model("codex/gpt-5.3-codex"));
        assert_eq!(
            remote_model_id("codex/gpt-5.3-codex"),
            Some("gpt-5.3-codex")
        );
        assert!(!is_codex_model("gpt-5.3-codex"));
        assert!(!is_codex_model("codex/provider/model"));
        assert!(!is_codex_model("codex/model\nforged"));
    }

    #[test]
    fn codex_session_ids_reject_control_characters() {
        assert!(is_codex_session("codex:0199-test-thread"));
        assert_eq!(
            thread_id("codex:0199-test-thread").unwrap(),
            "0199-test-thread"
        );
        assert!(!is_codex_session("codex:"));
        assert!(!is_codex_session("codex:thread\nforged"));
    }

    #[test]
    fn account_fields_accept_only_chatgpt_accounts() {
        let account = json!({
            "account": {
                "type": "chatgpt",
                "email": "person@example.com",
                "planType": "plus"
            }
        });
        assert_eq!(
            account_fields(&account),
            (true, Some("person@example.com".into()), Some("plus".into()))
        );
        assert_eq!(
            account_fields(&json!({ "account": null })),
            (false, None, None)
        );
    }

    #[test]
    fn connection_labels_are_bounded_and_display_safe() {
        assert_eq!(normalized_connection_label(None), "ChatGPT");
        assert_eq!(
            normalized_connection_label(Some(" \n\t ".into())),
            "ChatGPT"
        );
        assert_eq!(
            normalized_connection_label(Some("  Work\n account  ".into())),
            "Work account"
        );
        assert_eq!(
            normalized_connection_label(Some("x".repeat(200)))
                .chars()
                .count(),
            128
        );
    }
}
