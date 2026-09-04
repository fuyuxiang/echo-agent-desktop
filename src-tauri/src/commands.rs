//! Tauri command table — the frontend↔Rust contract.
//!
//! Commands are declared with `#[tauri::command]` and registered in lib.rs.
//! They drive the in-process EchoAgent runtime (see agent_runtime.rs) and bridge streamed
//! events back via Tauri events (see bridge.rs).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Emitter, Manager, State};

use crate::agent_runtime::{self, AgentHandle, InitOutcome};
use crate::bridge::{
    FolderTrusts, PendingInteractionsFrontend, PermissionOutcome, Permissions, PlanApprovalOutcome,
    PlanApprovals, QuestionOutcome, Questions,
};
use crate::sessions::{self, SessionSummary, WorkspaceInfo};

const AGENT_INITIALIZE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
const NEW_SESSION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45);
const MODEL_CATALOG_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const MODEL_RELOAD_ATTEMPTS: usize = 3;
const MAX_SESSION_ID_CHARS: usize = 256;
const MAX_PROMPT_BYTES: usize = 4 * 1024 * 1024;
const MAX_DISPLAY_TEXT_BYTES: usize = 4 * 1024 * 1024;
const MAX_QUESTION_FIELDS: usize = 128;
const MAX_QUESTION_KEY_CHARS: usize = 16 * 1024;
const MAX_QUESTION_VALUE_CHARS: usize = 64 * 1024;
const MAX_QUESTION_SELECTIONS: usize = 64;
const MAX_QUESTION_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

fn valid_session_id(value: &str) -> bool {
    !value.trim().is_empty()
        && value.chars().count() <= MAX_SESSION_ID_CHARS
        && !value.chars().any(char::is_control)
}

fn validate_send_payload(
    session_id: &str,
    text: &str,
    display_text: Option<&str>,
) -> Result<(), String> {
    if !valid_session_id(session_id) {
        return Err("会话 ID 无效或过长".into());
    }
    if text.len() > MAX_PROMPT_BYTES {
        return Err("消息内容不能超过 4 MiB".into());
    }
    if display_text.is_some_and(|value| value.len() > MAX_DISPLAY_TEXT_BYTES) {
        return Err("展示文本不能超过 4 MiB".into());
    }
    Ok(())
}

#[derive(Debug, Clone, Default)]
pub(crate) struct RuntimeModelState {
    initialized: bool,
    revision: Option<String>,
    model_ids: Vec<String>,
    last_error: Option<String>,
    /// Sender identity that produced this snapshot. A late response from a
    /// retired Runtime must never mark a newly-started Runtime as ready.
    sender: Option<xai_acp_lib::AcpAgentTx>,
}

/// State held across commands. The agent channel endpoints live here once
/// `agent_init` has spawned the agent.
#[derive(Default)]
pub struct AppState {
    pub handle: Mutex<Option<AgentHandle>>,
    /// Once the dispatcher owns the rx half, only the tx is reachable. We
    /// stash a clone of the tx sender here for commands to use.
    pub tx: Mutex<Option<xai_acp_lib::AcpAgentTx>>,
    pub cwd: Mutex<Option<PathBuf>>,
    /// Background automation scheduler bound to the current agent runtime.
    /// Replacing/aborting it on restart prevents a stale task from retaining a
    /// closed ACP sender forever.
    pub automation_scheduler: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// Last model configuration positively acknowledged by the embedded
    /// Runtime. Disk configuration alone must never unlock message sending.
    pub(crate) runtime_models: Mutex<RuntimeModelState>,
    /// Serialize Runtime model reloads. Organization sync, settings edits and
    /// startup can all request a reload at the same time; overlapping ACP
    /// reloads make it impossible to know which disk revision was applied.
    pub(crate) model_reload_lock: tokio::sync::Mutex<()>,
    /// Serialize `agent_init`. The command is reachable from startup, the retry
    /// button and the settings dialog at once; interleaved runs would let an
    /// earlier call's failure cleanup tear down a later, healthy Runtime.
    pub(crate) init_lock: tokio::sync::Mutex<()>,
    /// Monotonic initialization generation. Cleanup paths and lifecycle events
    /// carry the generation that produced them so a retired Runtime can never
    /// invalidate its replacement.
    pub(crate) init_generation: std::sync::atomic::AtomicU64,
    /// Sessions created by a `new_session` request whose caller had already
    /// timed out. The Runtime completes and persists these regardless, so they
    /// are tracked here and reclaimed instead of leaking as ghost sessions.
    pub(crate) orphaned_sessions: Mutex<Vec<OrphanedSession>>,
    /// Native-authoritative workspace binding for every session admitted into
    /// the current Runtime generation. Renderer-provided session ids and paths
    /// are never sufficient to authorize attachment reads.
    session_workspaces: Mutex<HashMap<String, PathBuf>>,
}

/// A session the Runtime finished creating after its caller stopped waiting.
/// `cwd` and `model_id` are kept so a retry only adopts a session that matches
/// what it would have asked for.
#[derive(Debug, Clone)]
pub(crate) struct OrphanedSession {
    pub(crate) session_id: String,
    pub(crate) cwd: String,
    pub(crate) model_id: Option<String>,
}

impl AppState {
    /// Claim the next initialization generation. Every later state mutation from
    /// that `agent_init` call is gated on the claimed value still being current.
    pub(crate) fn begin_init_generation(&self) -> u64 {
        self.init_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1
    }

    pub(crate) fn is_current_generation(&self, generation: u64) -> bool {
        self.init_generation
            .load(std::sync::atomic::Ordering::SeqCst)
            == generation
    }

    /// Record a session that arrived after its caller stopped waiting. The
    /// Runtime already persisted it, so the id is kept for reclamation.
    pub(crate) fn record_orphaned_session(&self, orphan: OrphanedSession) {
        let mut orphaned = self.orphaned_sessions.lock().unwrap();
        if !orphaned
            .iter()
            .any(|existing| existing.session_id == orphan.session_id)
        {
            orphaned.push(orphan);
        }
    }

    /// Adopt a previously orphaned session that matches the request a caller is
    /// about to make, so a retry after a timeout reuses the session the Runtime
    /// already created instead of leaving it behind and making another.
    pub(crate) fn take_orphaned_session(
        &self,
        cwd: &str,
        model_id: Option<&str>,
    ) -> Option<String> {
        let mut orphaned = self.orphaned_sessions.lock().unwrap();
        let index = orphaned.iter().position(|candidate| {
            candidate.cwd == cwd && candidate.model_id.as_deref() == model_id
        })?;
        Some(orphaned.remove(index).session_id)
    }

    pub(crate) fn clear_orphaned_sessions(&self) {
        self.orphaned_sessions.lock().unwrap().clear();
    }

    pub(crate) fn record_session_workspace(&self, session_id: &str, cwd: &Path) {
        self.session_workspaces
            .lock()
            .unwrap()
            .insert(session_id.to_string(), cwd.to_path_buf());
    }

    pub(crate) fn session_workspace(&self, session_id: &str) -> Result<PathBuf, String> {
        self.session_workspaces
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
            .ok_or_else(|| "当前会话尚未建立可信工作区绑定，请重新打开会话".to_string())
    }

    pub(crate) fn forget_session_workspace(&self, session_id: &str) {
        self.session_workspaces.lock().unwrap().remove(session_id);
    }

    pub(crate) fn clear_session_workspaces(&self) {
        self.session_workspaces.lock().unwrap().clear();
    }

    pub(crate) fn mark_runtime_models_initializing(&self) {
        *self.runtime_models.lock().unwrap() = RuntimeModelState::default();
    }

    pub(crate) fn mark_runtime_models_initializing_if_current(
        &self,
        sender: &xai_acp_lib::AcpAgentTx,
    ) -> bool {
        let tx = self.tx.lock().unwrap();
        if !tx
            .as_ref()
            .is_some_and(|current| current.same_channel(sender))
        {
            return false;
        }
        *self.runtime_models.lock().unwrap() = RuntimeModelState::default();
        true
    }

    pub(crate) fn mark_runtime_models_synced(
        &self,
        sender: &xai_acp_lib::AcpAgentTx,
        revision: String,
        model_ids: Vec<String>,
    ) -> bool {
        let current_sender = self.tx.lock().unwrap();
        if !current_sender
            .as_ref()
            .is_some_and(|current| current.same_channel(sender))
        {
            return false;
        }
        *self.runtime_models.lock().unwrap() = RuntimeModelState {
            initialized: true,
            revision: Some(revision),
            model_ids,
            last_error: None,
            sender: Some(sender.clone()),
        };
        true
    }

    pub(crate) fn mark_runtime_models_failed(&self, error: impl Into<String>) {
        let mut runtime = self.runtime_models.lock().unwrap();
        runtime.initialized = false;
        runtime.revision = None;
        runtime.model_ids.clear();
        runtime.sender = None;
        runtime.last_error = Some(error.into());
    }

    pub(crate) fn mark_runtime_models_failed_if_current(
        &self,
        sender: &xai_acp_lib::AcpAgentTx,
        error: impl Into<String>,
    ) {
        let current_sender = self.tx.lock().unwrap();
        if current_sender
            .as_ref()
            .is_some_and(|current| current.same_channel(sender))
        {
            self.mark_runtime_models_failed(error);
        }
    }

    /// Invalidate the command-facing runtime only when `tx` is still the
    /// currently installed agent. An older agent can finish joining after a
    /// user has already restarted a replacement; it must not poison the new
    /// runtime's readiness state.
    /// Returns whether the teardown applied. Callers use the result to decide
    /// whether to emit a user-visible "agent died" event: an event from a
    /// retired Runtime would make the frontend mark its healthy replacement
    /// unavailable.
    pub(crate) fn mark_runtime_dead_if_current(
        &self,
        tx: &xai_acp_lib::AcpAgentTx,
        error: impl Into<String>,
    ) -> bool {
        let mut current_tx = self.tx.lock().unwrap();
        let is_current = current_tx
            .as_ref()
            .is_some_and(|current| current.same_channel(tx));
        if !is_current {
            return false;
        }
        current_tx.take();
        drop(current_tx);
        if let Some(handle) = self.handle.lock().unwrap().take() {
            handle.cancel.cancel();
        }
        if let Some(scheduler) = self.automation_scheduler.lock().unwrap().take() {
            scheduler.abort();
        }
        crate::automations::clear_runtime_sessions();
        self.clear_orphaned_sessions();
        self.clear_session_workspaces();
        crate::agent_admin::clear_runtime_capabilities();
        self.mark_runtime_models_failed(error);
        true
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub ready: bool,
    pub reason: Option<String>,
    /// Model ids configured in `~/.echo-agent/config.toml`. When non-empty the
    /// app can route prompts to the matching `[model.*]` backend.
    pub providers: Vec<String>,
    /// True only when the embedded Runtime has acknowledged the exact
    /// model-related configuration revision currently on disk.
    pub runtime_ready: bool,
    pub synchronized: bool,
    /// Runtime catalog as shown to the frontend: upstream-branded ids removed.
    pub runtime_models: Vec<String>,
    pub last_runtime_error: Option<String>,
    /// The Runtime's catalog verbatim, used for authorization decisions only.
    ///
    /// Not serialized: the frontend must render `runtime_models`. Gate checks
    /// (`validate_runtime_ready`) read this instead, so the display filter can
    /// never refuse a model the Runtime actually loaded — including a user's own
    /// connection whose id happens to contain a brand token.
    #[serde(skip)]
    pub unfiltered_runtime_models: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitResult {
    pub ok: bool,
    pub auth: AuthStatus,
    pub cwd: String,
    pub agent_version: Option<String>,
    pub default_model_id: Option<String>,
    pub build_commit: String,
    /// Wall-clock time this binary was compiled.
    pub build_time: String,
    /// Commit date of `build_commit`. Kept distinct from `build_time`: the two
    /// diverge whenever a commit is built later than it was authored.
    pub build_commit_time: String,
    pub log_dir: String,
}

fn auth_status(state: &AppState) -> AuthStatus {
    let _ = crate::org::enforce_organization_model_lease();
    let (mut model_ids, disk_reason) = crate::providers::usable_model_ids();
    model_ids.sort();
    let revision = crate::providers::model_config_revision();
    let (runtime, sender_current) = {
        let current_sender = state.tx.lock().unwrap();
        let runtime = state.runtime_models.lock().unwrap().clone();
        let sender_current = runtime.sender.as_ref().is_some_and(|snapshot_sender| {
            current_sender
                .as_ref()
                .is_some_and(|current| current.same_channel(snapshot_sender))
        });
        (runtime, sender_current)
    };
    auth_status_from_snapshots(model_ids, disk_reason, &revision, runtime, sender_current)
}

fn auth_status_from_snapshots(
    model_ids: Vec<String>,
    disk_reason: Option<String>,
    revision: &str,
    runtime: RuntimeModelState,
    sender_current: bool,
) -> AuthStatus {
    // The Runtime's effective catalog is the only authority on which models can
    // actually serve a prompt. `[models]` filters (allowed_models,
    // hidden_models, disabled_models) are applied inside the Runtime, so a disk
    // entry legitimately may not appear in the catalog. Requiring disk ⊆ runtime
    // would lock chat permanently for a correct configuration that hides or
    // disables a single model.
    let synchronized =
        sender_current && runtime.initialized && runtime.revision.as_deref() == Some(revision);
    let runtime_ready =
        synchronized && runtime.last_error.is_none() && !runtime.model_ids.is_empty();
    let ready = runtime_ready;
    let reason = if ready {
        None
    } else if model_ids.is_empty() {
        disk_reason
    } else if let Some(error) = runtime.last_error.clone() {
        Some(format!("Agent Runtime 模型刷新失败：{error}"))
    } else if !runtime.initialized {
        Some("Agent Runtime 尚未完成初始化，请稍候或重启应用。".into())
    } else if !synchronized {
        Some("Agent Runtime 中的模型配置与磁盘不一致，请在设置中重试刷新。".into())
    } else {
        Some("Agent Runtime 未加载任何可用模型，请检查“设置 → 模型与连接”中的可用范围配置。".into())
    };
    // Branded-id filtering applies ONLY to the two fields the frontend renders.
    // Every gate above (`synchronized`, `runtime_ready`, `ready`, `reason`) is
    // computed from the unfiltered catalog on purpose: an empty filtered list
    // must never flip `ready` to false and lock chat. `require_runtime_ready`
    // likewise validates a requested model against the unfiltered catalog, so a
    // legitimate request is never refused because of a display filter.
    //
    // For a correctly isolated BYOK setup this is a no-op — the user's own model
    // ids carry no upstream brand. It matters when the source-level isolation in
    // `agent_runtime` fails (e.g. an upstream upgrade renames the config keys it
    // depends on): the UI stays clean instead of surfacing bundled model ids.
    AuthStatus {
        ready,
        reason,
        providers: strip_upstream_branded_ids(model_ids),
        runtime_ready,
        synchronized,
        runtime_models: strip_upstream_branded_ids(runtime.model_ids.clone()),
        last_runtime_error: runtime.last_error,
        unfiltered_runtime_models: runtime.model_ids,
    }
}

/// Upstream vendor brand tokens that must not reach the desktop UI.
///
/// Kept in lockstep with `src/lib/model-branding.ts` — the frontend filters the
/// same tokens as a second layer for values that do not flow through here (usage
/// records, transcript model dividers).
const UPSTREAM_BRAND_TOKENS: &[&str] = &["grok", "xai", "x.ai", "spacexai"];

fn is_upstream_branded_model_id(id: &str) -> bool {
    let normalized = id.to_ascii_lowercase();
    UPSTREAM_BRAND_TOKENS
        .iter()
        .any(|token| normalized.contains(token))
}

fn strip_upstream_branded_ids(ids: Vec<String>) -> Vec<String> {
    ids.into_iter()
        .filter(|id| !is_upstream_branded_model_id(id))
        .collect()
}

/// Admit a command only after the in-process Runtime has acknowledged the same
/// model configuration that is currently on disk. This is deliberately checked
/// in Rust as well as in the Composer: queue/plan/automation callers can invoke
/// `agent_send` without going through the visible send button.
pub(crate) fn require_runtime_ready(
    state: &AppState,
    requested_model: Option<&str>,
) -> Result<(), String> {
    let status = auth_status(state);
    validate_runtime_ready(&status, requested_model)
}

fn validate_runtime_ready(
    status: &AuthStatus,
    requested_model: Option<&str>,
) -> Result<(), String> {
    if !status.ready {
        let reason = status
            .reason
            .clone()
            .unwrap_or_else(|| "Agent Runtime 模型未就绪，请在设置中重试模型配置。".into());
        tracing::warn!(%reason, requested_model, "agent command blocked by runtime readiness gate");
        return Err(reason);
    }
    if let Some(model_id) = requested_model {
        // Deliberately the unfiltered catalog: the display filter must not gate
        // what can be sent (see `AuthStatus::unfiltered_runtime_models`).
        if !status
            .unfiltered_runtime_models
            .iter()
            .any(|available| available == model_id)
        {
            let reason = format!("Agent Runtime 尚未加载模型“{model_id}”，请刷新模型配置后重试。");
            tracing::warn!(%reason, model_id, "agent command requested unavailable runtime model");
            return Err(reason);
        }
    }
    Ok(())
}

/// Read the model-config revision without accepting a torn snapshot while
/// config.toml is being atomically replaced. A caller can compare the returned
/// revision with the revision observed before the Runtime reload.
fn stable_model_revision() -> Option<String> {
    for _ in 0..4 {
        let before = crate::providers::model_config_revision();
        let after = crate::providers::model_config_revision();
        if before == after {
            return Some(after);
        }
        std::thread::yield_now();
    }
    None
}

/// Tear down a partially initialized runtime before returning an init error.
/// The dispatcher will naturally stop once its ACP channel is closed; clearing
/// the command-facing handles immediately prevents sends from hanging on a
/// stale channel during a retry.
/// Only the generation that owns the current runtime may tear it down; a stale
/// call returns without touching a newer, healthy runtime.
fn clear_runtime_after_init_failure(state: &AppState, generation: u64) {
    if !state.is_current_generation(generation) {
        tracing::warn!(
            generation,
            "skipping init failure cleanup for a superseded generation"
        );
        return;
    }
    if let Some(handle) = state.handle.lock().unwrap().take() {
        handle.cancel.cancel();
    }
    state.tx.lock().unwrap().take();
    if let Some(scheduler) = state.automation_scheduler.lock().unwrap().take() {
        scheduler.abort();
    }
    crate::automations::clear_runtime_sessions();
    state.clear_orphaned_sessions();
    state.clear_session_workspaces();
    crate::agent_admin::clear_runtime_capabilities();
    state.mark_runtime_models_initializing();
}

/// Reload model configuration and acknowledge it only when the file stayed
/// unchanged for the complete Runtime round-trip. Settings and organization
/// sync can write config.toml while a reload is in flight; retrying closes that
/// race instead of advertising a stale Runtime as ready.
pub(crate) async fn reload_models_and_sync(
    app: &tauri::AppHandle,
    state: &AppState,
    tx: &xai_acp_lib::AcpAgentTx,
) -> Result<(), String> {
    let _reload_guard = state.model_reload_lock.lock().await;
    if !state.mark_runtime_models_initializing_if_current(tx) {
        return Err("Agent Runtime 已在模型刷新期间重启，请重试。".into());
    }
    let mut last_revision = None;
    for attempt in 1..=MODEL_RELOAD_ATTEMPTS {
        let before = crate::providers::model_config_revision();
        let result = crate::agent_admin::request_internal_reload_and_wait(tx, "models").await;
        match result {
            Err(error) => {
                state.mark_runtime_models_failed_if_current(tx, error.clone());
                return Err(error);
            }
            Ok(()) => {
                let after = crate::providers::model_config_revision();
                if before == after {
                    if let Some(revision) = stable_model_revision() {
                        if revision == before {
                            match tokio::time::timeout(
                                MODEL_CATALOG_TIMEOUT,
                                agent_runtime::model_ids(tx),
                            )
                            .await
                            {
                                Err(_) => {
                                    let error = format!(
                                        "读取 Agent Runtime 模型目录超时（{} 秒）",
                                        MODEL_CATALOG_TIMEOUT.as_secs()
                                    );
                                    state.mark_runtime_models_failed_if_current(tx, error.clone());
                                    return Err(error);
                                }
                                Ok(Ok(mut runtime_model_ids)) => {
                                    runtime_model_ids.sort();
                                    runtime_model_ids.dedup();
                                    // An empty catalog is the one unrecoverable
                                    // outcome: it means the Runtime rejected the
                                    // reload (invalid model filters are dropped
                                    // silently by `apply_config`, which still
                                    // answers success) or every model was
                                    // filtered out. Retrying cannot fix a
                                    // configuration error, so fail with an
                                    // actionable reason instead of looping.
                                    if runtime_model_ids.is_empty() {
                                        let error = "Agent Runtime 未加载任何可用模型；请检查 config.toml 中 [models] 的 allowed_models / hidden_models / disabled_models 配置。".to_string();
                                        tracing::error!(attempt, %error, "Runtime model catalog is empty after reload");
                                        state.mark_runtime_models_failed_if_current(
                                            tx,
                                            error.clone(),
                                        );
                                        return Err(error);
                                    }
                                    let committed = state.mark_runtime_models_synced(
                                        tx,
                                        revision,
                                        runtime_model_ids,
                                    );
                                    if !committed {
                                        return Err(
                                            "Agent Runtime 已在模型刷新期间重启，请重试。".into()
                                        );
                                    }
                                    let _ = app.emit(
                                        "agent://models-update",
                                        serde_json::json!({ "source": "runtime-ready" }),
                                    );
                                    return Ok(());
                                }
                                Ok(Err(error)) => {
                                    state.mark_runtime_models_failed_if_current(
                                        tx,
                                        error.to_string(),
                                    );
                                    return Err(error.to_string());
                                }
                            }
                        }
                    }
                }
                last_revision = Some(after);
                tracing::warn!(
                    attempt,
                    "model config changed while Runtime reload was in flight; retrying"
                );
            }
        }
    }

    let error = format!(
        "模型配置在 Runtime 刷新期间持续变化（{} 次），发送功能已保持禁用，请重试。",
        MODEL_RELOAD_ATTEMPTS
    );
    tracing::error!(revision = ?last_revision, %error, "model Runtime reload did not converge");
    state.mark_runtime_models_failed_if_current(tx, error.clone());
    Err(error)
}

fn default_cwd() -> Result<PathBuf, String> {
    crate::paths::default_workspace_dir()
}

/// Validate, but never create, a session workspace capability. Only native
/// folder selection, the native default workspace, or trusted persisted roots
/// may populate `FilesystemAccess`; renderer calls cannot self-authorize by
/// reaching the session lifecycle API.
fn authorized_session_cwd(
    filesystem: &crate::shell_fs::FilesystemAccess,
    claimed: &str,
) -> Result<String, String> {
    filesystem
        .require_workspace(claimed)
        .map(|path| path.to_string_lossy().into_owned())
}

fn trusted_existing_session_cwd(
    state: &AppState,
    filesystem: &crate::shell_fs::FilesystemAccess,
    session_id: &str,
    claimed: Option<&str>,
) -> Result<PathBuf, String> {
    if !valid_session_id(session_id) {
        return Err("会话 ID 无效或过长".into());
    }
    if let Ok(bound) = state.session_workspace(session_id) {
        if let Some(claimed) = claimed.filter(|value| !value.trim().is_empty()) {
            let claimed = filesystem.require_workspace(claimed)?;
            if claimed != bound {
                return Err("会话工作区与后端绑定不一致".into());
            }
        }
        return Ok(bound);
    }
    let claimed = claimed
        .filter(|value| !value.trim().is_empty())
        .ok_or("历史会话操作必须提供工作区")?;
    let canonical = filesystem.require_workspace(claimed)?;
    let canonical_text = canonical.to_string_lossy();
    if !sessions::list_sessions(&canonical_text, true)
        .iter()
        .any(|summary| summary.session_id == session_id)
    {
        return Err("会话不属于声明的工作区".into());
    }
    Ok(canonical)
}

/// Initialize the in-process EchoAgent runtime. Spawns the agent thread, runs
/// `initialize`, and starts the dispatcher.
#[tauri::command]
pub async fn agent_init(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    permissions: State<'_, Permissions>,
    questions: State<'_, Questions>,
    plan_approvals: State<'_, PlanApprovals>,
    folder_trusts: State<'_, FolderTrusts>,
    cwd: Option<String>,
) -> Result<InitResult, String> {
    // Startup, the retry button and the settings dialog can all call this at
    // once. Serializing the whole lifecycle keeps one initialization's spawn,
    // handshake and cleanup from interleaving with another's.
    let _init_guard = state.init_lock.lock().await;
    let generation = state.begin_init_generation();

    // A renderer/runtime restart invalidates every outstanding reverse
    // request. Resolve all of them conservatively before installing the new
    // runtime so an old request can never approve work in a new generation.
    tokio::join!(
        permissions.cancel_all(),
        questions.cancel_all(),
        plan_approvals.cancel_all(),
        folder_trusts.cancel_all(),
    );

    // A retry/re-init must retire the prior runtime and its scheduler before a
    // replacement is spawned; dropping the handle alone does not cancel it.
    if let Some(scheduler) = state.automation_scheduler.lock().unwrap().take() {
        scheduler.abort();
    }
    if let Some(previous) = state.handle.lock().unwrap().take() {
        previous.cancel.cancel();
    }
    state.tx.lock().unwrap().take();
    crate::automations::clear_runtime_sessions();
    state.clear_orphaned_sessions();
    state.clear_session_workspaces();
    crate::agent_admin::clear_runtime_capabilities();
    state.mark_runtime_models_initializing();

    let cwd = match cwd {
        Some(cwd) => {
            let filesystem = app.state::<crate::shell_fs::FilesystemAccess>();
            filesystem.require_workspace(&cwd)?
        }
        None => {
            let cwd = default_cwd()?;
            let filesystem = app.state::<crate::shell_fs::FilesystemAccess>();
            filesystem.authorize_workspace(&cwd.to_string_lossy())?
        }
    };
    *state.cwd.lock().unwrap() = Some(cwd.clone());

    // Spawn the agent off the async runtime. `spawn_agent_runtime` does blocking I/O
    // (config load, first-run bundled extract under ~/.echo-agent). Running it
    // inline would stall Tauri's tokio workers and freeze the UI.
    let spawn_cwd = cwd.clone();
    let agent_runtime::AgentHandle {
        tx,
        rx,
        cancel,
        thread,
    } = tokio::task::spawn_blocking(move || agent_runtime::spawn_agent_runtime(spawn_cwd))
        .await
        .map_err(|e| format!("spawn EchoAgent task: {e}"))?
        .map_err(|e| format!("spawn EchoAgent runtime: {e}"))?;

    // Stash tx for later commands; move rx into the dispatcher.
    *state.tx.lock().unwrap() = Some(tx.clone());

    // Start the dispatcher that forwards agent→client messages to events.
    // `rx` is moved in; the dispatcher owns it for the app lifetime.
    crate::bridge::spawn_dispatcher(
        app.clone(),
        rx,
        permissions.share(),
        questions.share(),
        plan_approvals.share(),
        folder_trusts.share(),
    );

    // Install the command-facing handle before starting the death monitor. A
    // Runtime can fail immediately after spawn; publishing the handle first
    // ensures that the monitor can invalidate the same generation instead of
    // racing with a later stale write from this initialization call.
    let (_placeholder_tx, placeholder_rx) =
        tokio::sync::mpsc::unbounded_channel::<xai_acp_lib::AcpClientMessage>();
    *state.handle.lock().unwrap() = Some(AgentHandle {
        tx: tx.clone(),
        // Unused placeholder rx — the real rx lives in the dispatcher.
        rx: placeholder_rx,
        cancel: cancel.clone(),
        thread: None,
    });

    // Monitor the agent thread: if it exits unexpectedly (panic/crash), notify
    // the frontend so it can show a "restart agent" prompt instead of hanging.
    if let Some(join_handle) = thread {
        let monitor_app = app.clone();
        let monitor_cancel = cancel.clone();
        let monitor_tx = tx.clone();
        tokio::task::spawn_blocking(move || {
            let result = join_handle.join();
            // If the cancel token was triggered, this was an intentional shutdown — don't alarm.
            if monitor_cancel.is_cancelled() {
                return;
            }
            let reason = match result {
                Ok(Ok(())) => "agent thread exited normally (unexpected)".to_string(),
                Ok(Err(e)) => format!("agent error: {e}"),
                Err(_) => "agent thread panicked".to_string(),
            };
            tracing::error!(reason = %reason, generation, "EchoAgent runtime thread died");
            // Emit only when this runtime was still the installed one. A late
            // exit from a superseded runtime must not mark its replacement dead.
            let invalidated = monitor_app
                .state::<AppState>()
                .mark_runtime_dead_if_current(&monitor_tx, reason.clone());
            if !invalidated {
                tracing::info!(
                    generation,
                    "suppressing agent-died event from a superseded runtime"
                );
                return;
            }
            let _ = monitor_app.emit(
                "agent://agent-died",
                serde_json::json!({ "reason": reason, "generation": generation }),
            );
        });
    }

    // Run the ACP initialization lifecycle. Provider credentials are managed
    // solely through the model-provider configuration.
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent channel not ready")?;

    tracing::info!("agent initialize send");
    let init_outcome: InitOutcome = match tokio::time::timeout(
        AGENT_INITIALIZE_TIMEOUT,
        agent_runtime::initialize(&tx),
    )
    .await
    {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(error)) => {
            let message = format!("initialize: {error}");
            tracing::error!(%message, "agent initialize failed");
            clear_runtime_after_init_failure(&state, generation);
            return Err(message);
        }
        Err(_) => {
            let message = "initialize timed out after 60 seconds".to_string();
            tracing::error!(%message, "agent initialize timed out");
            clear_runtime_after_init_failure(&state, generation);
            return Err(message);
        }
    };
    tracing::info!("agent initialize OK");

    // Close the startup race with settings/org writes: the Runtime explicitly
    // reloads the latest disk model config before it is advertised as ready.
    if let Err(error) = reload_models_and_sync(&app, &state, &tx).await {
        tracing::error!(%error, "initial model reload failed");
    }
    let auth = auth_status(&state);

    // Start the automations scheduler now that the agent channel is up.
    // Idempotent — safe if agent_init is somehow called twice.
    if let (Some(tx), Some(cwd)) = (
        state.tx.lock().unwrap().clone(),
        state.cwd.lock().unwrap().clone(),
    ) {
        let scheduler = crate::automations::start_scheduler(app.clone(), tx, cwd);
        if let Some(previous) = state
            .automation_scheduler
            .lock()
            .unwrap()
            .replace(scheduler)
        {
            previous.abort();
        }
    }

    Ok(InitResult {
        ok: true,
        auth,
        cwd: cwd.to_string_lossy().into_owned(),
        agent_version: init_outcome.agent_version,
        default_model_id: init_outcome.default_model_id,
        build_commit: env!("ECHOAGENT_BUILD_COMMIT").to_string(),
        build_time: env!("ECHOAGENT_BUILD_TIME").to_string(),
        build_commit_time: env!("ECHOAGENT_BUILD_COMMIT_TIME").to_string(),
        log_dir: crate::logging::log_dir().to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn agent_auth_status(state: State<'_, AppState>) -> AuthStatus {
    auth_status(&state)
}

#[tauri::command]
pub async fn agent_new_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    cwd: String,
    model_id: Option<String>,
) -> Result<String, String> {
    crate::policy::require_feature("sessions")?;
    crate::org::enforce_skill_lease();
    let cwd = {
        let filesystem = app.state::<crate::shell_fs::FilesystemAccess>();
        authorized_session_cwd(&filesystem, &cwd)?
    };
    if let Some(model_id) = model_id.as_deref() {
        crate::policy::require_model(model_id)?;
    }
    require_runtime_ready(&state, model_id.as_deref())?;
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;

    // A previous attempt may have timed out while the Runtime went on to create
    // and persist the session. Adopting it keeps a retry from stacking up ghost
    // sessions the UI never learned about.
    if let Some(session_id) = state.take_orphaned_session(&cwd, model_id.as_deref()) {
        tracing::info!(%session_id, "adopting session created by a timed-out request");
        state.record_session_workspace(&session_id, Path::new(&cwd));
        crate::team_mcp::persist_registration(&tx, &session_id);
        crate::org_mcp::persist_registration(&tx, &session_id);
        return Ok(session_id);
    }

    tracing::info!(
        model_id = model_id.as_deref(),
        "agent new_session command send"
    );

    // The ACP gateway spawns each request independently, so dropping this future
    // on timeout would not stop the Runtime from finishing and persisting the
    // session. Run it detached and hand a late result back to the state instead
    // of losing it.
    let (result_tx, result_rx) = tokio::sync::oneshot::channel();
    let task_app = app.clone();
    let task_tx = tx.clone();
    let task_cwd = cwd.clone();
    let task_model = model_id.clone();
    tokio::spawn(async move {
        let result = agent_runtime::new_session(
            &task_tx,
            &PathBuf::from(task_cwd.clone()),
            task_model.as_deref(),
        )
        .await
        .map_err(|error| error.to_string());
        let Err(unclaimed) = result_tx.send(result) else {
            return;
        };
        match unclaimed {
            Ok(session_id) => {
                if !valid_session_id(&session_id) {
                    tracing::error!("Runtime returned an invalid orphaned session id");
                    return;
                }
                tracing::warn!(
                    %session_id,
                    "new_session completed after its caller timed out; reclaiming"
                );
                crate::team_mcp::persist_registration(&task_tx, &session_id);
                crate::org_mcp::persist_registration(&task_tx, &session_id);
                task_app
                    .state::<AppState>()
                    .record_session_workspace(&session_id, Path::new(&task_cwd));
                task_app
                    .state::<AppState>()
                    .record_orphaned_session(OrphanedSession {
                        session_id: session_id.clone(),
                        cwd: task_cwd,
                        model_id: task_model,
                    });
                let _ = task_app.emit(
                    "agent://session-reclaimed",
                    serde_json::json!({ "sessionId": session_id }),
                );
            }
            Err(error) => {
                tracing::warn!(%error, "new_session failed after its caller timed out");
            }
        }
    });

    let session_id = match tokio::time::timeout(NEW_SESSION_TIMEOUT, result_rx).await {
        Err(_) => {
            tracing::error!(
                model_id = model_id.as_deref(),
                "agent new_session command timed out"
            );
            return Err("创建 Agent 会话超时（45 秒），请重试；若持续失败请重启应用。".to_string());
        }
        Ok(Err(_)) => {
            tracing::error!("new_session task ended without producing a result");
            return Err("创建 Agent 会话失败：Agent Runtime 未返回结果，请重试。".to_string());
        }
        Ok(Ok(Err(error))) => {
            tracing::error!(
                %error,
                model_id = model_id.as_deref(),
                "agent new_session command failed"
            );
            return Err(error);
        }
        Ok(Ok(Ok(session_id))) => session_id,
    };
    if !valid_session_id(&session_id) {
        return Err("Agent Runtime 返回的会话 ID 无效".into());
    }
    tracing::info!(%session_id, "agent new_session command OK");
    state.record_session_workspace(&session_id, Path::new(&cwd));
    // Team MCP server 已随 new_session 参数注入本会话；这里再异步持久化到
    // config.toml（一次即可），让 load_session 恢复的会话也能用。
    crate::team_mcp::persist_registration(&tx, &session_id);
    crate::org_mcp::persist_registration(&tx, &session_id);
    Ok(session_id)
}

#[tauri::command]
pub async fn agent_load_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    cwd: String,
) -> Result<(), String> {
    if !valid_session_id(&session_id) {
        return Err("会话 ID 无效或过长".into());
    }
    crate::org::enforce_skill_lease();
    let cwd = {
        let filesystem = app.state::<crate::shell_fs::FilesystemAccess>();
        let cwd = authorized_session_cwd(&filesystem, &cwd)?;
        if !sessions::list_sessions(&cwd, true)
            .iter()
            .any(|summary| summary.session_id == session_id)
        {
            return Err("会话不属于声明的工作区".into());
        }
        cwd
    };
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    agent_runtime::load_session(&tx, &session_id, &PathBuf::from(&cwd))
        .await
        .map_err(|e| e.to_string())?;
    state.record_session_workspace(&session_id, Path::new(&cwd));
    // 恢复的会话从 config.toml 读 MCP 列表 —— 若端口较上次运行漂移，这里
    // 的 upsert 会用当前 URL 刷新并 live 重连（EchoAgent 的 toggle 路径）。
    crate::team_mcp::persist_registration(&tx, &session_id);
    crate::org_mcp::persist_registration(&tx, &session_id);
    Ok(())
}

#[tauri::command]
pub fn agent_list_sessions(
    filesystem: State<'_, crate::shell_fs::FilesystemAccess>,
    cwd: String,
    include_archived: Option<bool>,
) -> Result<Vec<SessionSummary>, String> {
    let cwd = filesystem.require_workspace(&cwd)?;
    Ok(sessions::list_sessions(
        &cwd.to_string_lossy(),
        include_archived.unwrap_or(false),
    ))
}

#[tauri::command]
pub async fn agent_send(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    text: String,
    attachments: Option<Vec<String>>,
    display_text: Option<String>,
) -> Result<(), String> {
    validate_send_payload(&session_id, &text, display_text.as_deref())?;
    require_runtime_ready(&state, None)?;
    let workspace = state.session_workspace(&session_id)?;
    let attachments = attachments.unwrap_or_default();
    let attachments = if attachments.is_empty() {
        Vec::new()
    } else {
        app.state::<crate::shell_fs::FilesystemAccess>()
            .validate_session_attachments(&workspace, &attachments)?
    };
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    tracing::info!(%session_id, attachment_count = attachments.len(), "agent prompt send");
    agent_runtime::prompt_with_attachments(
        &tx,
        &session_id,
        &text,
        &attachments,
        display_text.as_deref(),
    )
    .await
    .map_err(|error| {
        tracing::error!(%session_id, error = ?error, "agent prompt failed");
        error.to_string()
    })
}

#[tauri::command]
pub async fn agent_cancel(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    if !valid_session_id(&session_id) {
        return Err("会话 ID 无效或过长".into());
    }
    state.session_workspace(&session_id)?;
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    agent_runtime::cancel(&tx, &session_id)
        .await
        .map_err(|e| e.to_string())
}

/// Cleanly shut down the agent (cancel token + clear state) so the frontend
/// can call `agent_init` again to restart. Used after `agent://agent-died`.
#[tauri::command]
pub async fn agent_shutdown(
    state: State<'_, AppState>,
    permissions: State<'_, Permissions>,
    questions: State<'_, Questions>,
    plan_approvals: State<'_, PlanApprovals>,
    folder_trusts: State<'_, FolderTrusts>,
) -> Result<(), String> {
    // Trigger the cancel token so the agent thread's `cancelled().await` resolves.
    if let Some(handle) = state.handle.lock().unwrap().take() {
        handle.cancel.cancel();
    }
    state.tx.lock().unwrap().take();
    if let Some(scheduler) = state.automation_scheduler.lock().unwrap().take() {
        scheduler.abort();
    }
    crate::automations::clear_runtime_sessions();
    state.clear_orphaned_sessions();
    state.clear_session_workspaces();
    crate::agent_admin::clear_runtime_capabilities();
    tokio::join!(
        permissions.cancel_all(),
        questions.cancel_all(),
        plan_approvals.cancel_all(),
        folder_trusts.cancel_all(),
    );
    state.mark_runtime_models_initializing();
    tracing::info!("EchoAgent agent shut down (ready for re-init)");
    Ok(())
}

/// Resolve a pending permission request from the frontend.
#[tauri::command]
pub async fn agent_resolve_permission(
    permissions: State<'_, Permissions>,
    request_id: String,
    option_id: Option<String>,
    cancelled: Option<bool>,
) -> Result<bool, String> {
    let outcome = match (cancelled.unwrap_or(false), option_id) {
        (true, _) => PermissionOutcome::Cancelled,
        (false, Some(id)) => PermissionOutcome::Selected(id),
        (false, None) => PermissionOutcome::Cancelled,
    };
    Ok(permissions.resolve(&request_id, outcome).await)
}

/// Return all currently parked agent→client interactions. The frontend calls
/// this after wiring event listeners, making permission/question/plan/trust
/// requests replayable across renderer reloads and background-session switches.
#[tauri::command]
pub async fn agent_list_pending_interactions(
    permissions: State<'_, Permissions>,
    questions: State<'_, Questions>,
    plan_approvals: State<'_, PlanApprovals>,
    folder_trusts: State<'_, FolderTrusts>,
    session_id: Option<String>,
) -> Result<PendingInteractionsFrontend, String> {
    Ok(crate::bridge::pending_interactions(
        &permissions,
        &questions,
        &plan_approvals,
        &folder_trusts,
        session_id.as_deref(),
    )
    .await)
}

/// Fulfil the exact `echo.agent/exit_plan_mode` reverse request. Unknown
/// outcomes are rejected instead of being interpreted as approval.
#[tauri::command]
pub async fn agent_resolve_plan_approval(
    plan_approvals: State<'_, PlanApprovals>,
    request_id: String,
    outcome: String,
    feedback: Option<String>,
) -> Result<bool, String> {
    let outcome = match outcome.as_str() {
        "approved" => PlanApprovalOutcome::Approved,
        "cancelled" => PlanApprovalOutcome::Cancelled {
            feedback: feedback.filter(|value| !value.trim().is_empty()),
        },
        "abandoned" => PlanApprovalOutcome::Abandoned,
        other => return Err(format!("invalid plan approval outcome: {other}")),
    };
    Ok(plan_approvals.resolve(&request_id, outcome).await)
}

/// Resolve a pending question request from the frontend.
///
/// Wire contract for EchoAgent's `AskUserQuestionExtResponse`:
/// - `outcome: "cancelled"` → `{ "outcome": "cancelled" }`
/// - `outcome: "accepted"` → `{ "outcome": "accepted", ... }`
/// - plan-only actions preserve partial answers as `chat_about_this` or
///   `skip_interview`.
///
/// `answers` must be keyed by **question text** (not synthetic id). Values may
/// be a string or a list of strings (multi-select). Freeform answers use
/// label `"Other"` with the typed text in `annotations[question].notes`.
#[tauri::command]
pub async fn agent_resolve_question(
    questions: State<'_, Questions>,
    request_id: String,
    mut answers: Option<std::collections::HashMap<String, serde_json::Value>>,
    annotations: Option<std::collections::HashMap<String, QuestionAnnotationDto>>,
    partial_answers: Option<std::collections::HashMap<String, String>>,
    outcome: Option<String>,
    cancelled: Option<bool>,
) -> Result<bool, String> {
    validate_question_payload(
        &request_id,
        answers.as_ref(),
        annotations.as_ref(),
        partial_answers.as_ref(),
        outcome.as_deref(),
    )?;
    let requested = if cancelled.unwrap_or(false) {
        "cancelled"
    } else {
        outcome.as_deref().unwrap_or(if answers.is_some() {
            "accepted"
        } else {
            "cancelled"
        })
    };
    let outcome = match requested {
        "cancelled" => QuestionOutcome::Cancelled,
        "chat_about_this" => QuestionOutcome::ChatAboutThis {
            partial_answers: partial_answers.unwrap_or_default(),
        },
        "skip_interview" => QuestionOutcome::SkipInterview {
            partial_answers: partial_answers.unwrap_or_default(),
        },
        "accepted" => {
            let mut normalized = std::collections::HashMap::new();
            for (k, v) in answers.take().unwrap_or_default() {
                let labels = match v {
                    serde_json::Value::String(s) => {
                        if s.is_empty() {
                            continue;
                        }
                        vec![s]
                    }
                    serde_json::Value::Array(arr) => arr
                        .into_iter()
                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                        .filter(|s| !s.is_empty())
                        .collect(),
                    _ => continue,
                };
                if !labels.is_empty() {
                    normalized.insert(k, labels);
                }
            }
            let anns = annotations.map(|m| {
                m.into_iter()
                    .map(|(k, v)| {
                        (
                            k,
                            crate::bridge::QuestionAnnotation {
                                preview: v.preview,
                                notes: v.notes,
                            },
                        )
                    })
                    .collect()
            });
            QuestionOutcome::Accepted {
                answers: normalized,
                annotations: anns,
            }
        }
        other => return Err(format!("invalid question outcome: {other}")),
    };
    Ok(questions.resolve(&request_id, outcome).await)
}

/// DTO for per-question annotations from the frontend.
#[derive(Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionAnnotationDto {
    pub preview: Option<String>,
    pub notes: Option<String>,
}

fn validate_question_payload(
    request_id: &str,
    answers: Option<&std::collections::HashMap<String, serde_json::Value>>,
    annotations: Option<&std::collections::HashMap<String, QuestionAnnotationDto>>,
    partial_answers: Option<&std::collections::HashMap<String, String>>,
    outcome: Option<&str>,
) -> Result<(), String> {
    if !valid_session_id(request_id) {
        return Err("问题请求 ID 无效或过长".into());
    }
    if outcome.is_some_and(|value| value.len() > 32 || value.chars().any(char::is_control)) {
        return Err("问题响应类型无效".into());
    }
    let answers_len = answers.map_or(0, HashMap::len);
    let annotations_len = annotations.map_or(0, HashMap::len);
    let partial_len = partial_answers.map_or(0, HashMap::len);
    if answers_len > MAX_QUESTION_FIELDS
        || annotations_len > MAX_QUESTION_FIELDS
        || partial_len > MAX_QUESTION_FIELDS
    {
        return Err(format!("问题响应字段不能超过 {MAX_QUESTION_FIELDS} 个"));
    }
    let valid_key = |value: &str| {
        !value.trim().is_empty()
            && value.chars().count() <= MAX_QUESTION_KEY_CHARS
            && !value.chars().any(|character| character == '\0')
    };
    let valid_value = |value: &str| {
        value.chars().count() <= MAX_QUESTION_VALUE_CHARS
            && !value.chars().any(|character| character == '\0')
    };
    if answers.is_some_and(|items| {
        items.iter().any(|(key, value)| {
            !valid_key(key)
                || match value {
                    serde_json::Value::String(value) => !valid_value(value),
                    serde_json::Value::Array(values) => {
                        values.len() > MAX_QUESTION_SELECTIONS
                            || values
                                .iter()
                                .any(|value| value.as_str().is_none_or(|value| !valid_value(value)))
                    }
                    _ => true,
                }
        })
    }) || annotations.is_some_and(|items| {
        items.iter().any(|(key, value)| {
            !valid_key(key)
                || value
                    .preview
                    .as_deref()
                    .is_some_and(|value| !valid_value(value))
                || value
                    .notes
                    .as_deref()
                    .is_some_and(|value| !valid_value(value))
        })
    }) || partial_answers.is_some_and(|items| {
        items
            .iter()
            .any(|(key, value)| !valid_key(key) || !valid_value(value))
    }) {
        return Err("问题响应包含无效或过长字段".into());
    }
    let encoded = serde_json::to_vec(&(answers, annotations, partial_answers))
        .map_err(|error| format!("无法校验问题响应：{error}"))?;
    if encoded.len() > MAX_QUESTION_RESPONSE_BYTES {
        return Err("问题响应不能超过 4 MiB".into());
    }
    Ok(())
}

/// Switch the model used by an existing session. Maps to EchoAgent's
/// `session/set_model`. May reject with `MODEL_SWITCH_INCOMPATIBLE_AGENT`
/// if the session has turns and the new model needs a different harness —
/// the error string is forwarded verbatim so the UI can prompt accordingly.
#[tauri::command]
pub async fn agent_set_model(
    state: State<'_, AppState>,
    session_id: String,
    model_id: String,
) -> Result<(), String> {
    if !valid_session_id(&session_id) {
        return Err("会话 ID 无效或过长".into());
    }
    state.session_workspace(&session_id)?;
    crate::policy::require_model(&model_id)?;
    require_runtime_ready(&state, Some(&model_id))?;
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    agent_runtime::set_session_model(&tx, &session_id, &model_id)
        .await
        .map_err(|e| e.to_string())
}

/// List every working directory EchoAgent has seen (deduplicated), with a session
/// count per cwd. Used to populate the Composer's workspace picker.
#[tauri::command]
pub fn agent_list_workspaces(
    filesystem: State<'_, crate::shell_fs::FilesystemAccess>,
) -> Vec<WorkspaceInfo> {
    let workspaces = sessions::list_workspaces();
    for workspace in &workspaces {
        if let Err(error) = filesystem.authorize_workspace(&workspace.cwd) {
            tracing::warn!(%error, cwd = %workspace.cwd, "persisted workspace was not added to filesystem allow-list");
        }
    }
    workspaces
}

/// Rename a session via EchoAgent's `echo.agent/session/rename` extension method. On
/// success EchoAgent also broadcasts `SessionSummaryGenerated`, which our bridge
/// forwards as the `agent://summary` event — so the frontend will receive the
/// new title twice (once from this return, once from the event). That's fine:
/// both arrive at the same store `upsert` and are idempotent.
#[tauri::command]
pub async fn agent_rename_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    title: String,
    cwd: Option<String>,
) -> Result<(), String> {
    if !valid_session_id(&session_id) {
        return Err("会话 ID 无效或过长".into());
    }
    if title.trim().is_empty()
        || title.chars().count() > 512
        || title.chars().any(|character| character == '\0')
    {
        return Err("会话标题为空、过长或包含非法字符".into());
    }
    let workspace = trusted_existing_session_cwd(
        &state,
        &app.state::<crate::shell_fs::FilesystemAccess>(),
        &session_id,
        cwd.as_deref(),
    )?;
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    let workspace = workspace.to_string_lossy().into_owned();
    agent_runtime::rename_session(&tx, &session_id, &title, Some(&workspace))
        .await
        .map_err(|e| e.to_string())
}

/// Delete a session's persisted history via EchoAgent's `echo.agent/session/delete`.
/// Removes the on-disk session directory; the frontend drops its sidebar
/// entry on success.
#[tauri::command]
pub async fn agent_delete_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    cwd: Option<String>,
) -> Result<(), String> {
    if !valid_session_id(&session_id) {
        return Err("会话 ID 无效或过长".into());
    }
    let workspace = trusted_existing_session_cwd(
        &state,
        &app.state::<crate::shell_fs::FilesystemAccess>(),
        &session_id,
        cwd.as_deref(),
    )?;
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    let workspace = workspace.to_string_lossy().into_owned();
    agent_runtime::delete_session(&tx, &session_id, Some(&workspace))
        .await
        .map_err(|e| e.to_string())?;
    state.forget_session_workspace(&session_id);
    Ok(())
}

/// Pin or unpin a session. EchoAgent's `Summary` has no `pinned` field, so this is
/// EchoAgent-only state stored in `~/.echo-agent/echoagent-state.json`. Returns the
/// new pinned value so the frontend can update without a re-fetch.
#[tauri::command]
pub fn agent_set_session_pinned(session_id: String, pinned: bool) -> Result<bool, String> {
    crate::meta::set_pinned(&session_id, pinned)
}

/// Fetch the session's context-window snapshot (`echo.agent/session/info`) for the
/// composer's context-usage pill/popover. Fails when the session isn't live
/// in the agent (e.g. an old session never loaded this launch) — the
/// frontend treats that as "no data" and hides the pill.
#[tauri::command]
pub async fn agent_session_info(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<serde_json::Value, String> {
    if !valid_session_id(&session_id) {
        return Err("会话 ID 无效或过长".into());
    }
    state.session_workspace(&session_id)?;
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    agent_runtime::session_info(&tx, &session_id)
        .await
        .map_err(|e| e.to_string())
}

/// Fetch the session's cumulative token usage (`echo.agent/session/usage`) — used
/// by the context-usage popover for the average cache hit rate.
#[tauri::command]
pub async fn agent_session_usage(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<serde_json::Value, String> {
    if !valid_session_id(&session_id) {
        return Err("会话 ID 无效或过长".into());
    }
    state.session_workspace(&session_id)?;
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    agent_runtime::session_usage(&tx, &session_id)
        .await
        .map_err(|e| e.to_string())
}

/// Archive or unarchive a session. EchoAgent's `Summary` has no `archived` field,
/// so this is EchoAgent-only state stored in `~/.echo-agent/echoagent-state.json`.
/// Archived sessions are filtered out of `list_sessions`. Returns the new
/// archived value so the frontend can update without a re-fetch.
#[tauri::command]
pub fn agent_set_session_archived(session_id: String, archived: bool) -> Result<bool, String> {
    crate::meta::set_archived(&session_id, archived)
}

/// Bind an expert to a session (EchoAgent-only state). Returns `true` on success.
#[tauri::command]
pub fn agent_set_session_expert(
    state: State<'_, AppState>,
    session_id: String,
    expert_id: String,
    expert_name: String,
    source: String,
    avatar_local: Option<String>,
) -> Result<bool, String> {
    // Requiring a live backend binding prevents a forged renderer payload from
    // attaching metadata to arbitrary historical session ids. Expert fields,
    // especially local avatar paths, are resolved against exact rows emitted
    // by backend-managed catalogs rather than trusted from IPC.
    if !valid_session_id(&session_id) {
        return Err("会话 ID 无效或过长".into());
    }
    state.session_workspace(&session_id)?;
    let binding = match source.as_str() {
        "marketplace" => crate::experts::require_loaded_marketplace_expert(
            &expert_id,
            &expert_name,
            avatar_local.as_deref(),
        )?,
        "local" => crate::agents_store::require_listed_local_expert(
            &expert_id,
            &expert_name,
            avatar_local.as_deref(),
        )?,
        _ => return Err("专家来源未经后端授权".into()),
    };
    crate::meta::set_expert(&session_id, binding)
}

/// Remove the expert binding from a session. Returns `true` if a binding was removed.
#[tauri::command]
pub fn agent_clear_session_expert(session_id: String) -> Result<bool, String> {
    crate::meta::clear_expert(&session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renderer_message_and_question_payloads_are_bounded() {
        assert!(validate_send_payload("session", "hello", Some("hello")).is_ok());
        assert!(validate_send_payload("session", &"x".repeat(MAX_PROMPT_BYTES + 1), None).is_err());
        assert!(
            validate_send_payload(&"s".repeat(MAX_SESSION_ID_CHARS + 1), "hello", None).is_err()
        );

        let valid_answers =
            HashMap::from([("Which?".into(), serde_json::json!(["first", "second"]))]);
        assert!(validate_question_payload(
            "request",
            Some(&valid_answers),
            None,
            None,
            Some("accepted")
        )
        .is_ok());
        let oversized = HashMap::from([(
            "Which?".into(),
            serde_json::Value::String("x".repeat(MAX_QUESTION_VALUE_CHARS + 1)),
        )]);
        assert!(validate_question_payload(
            "request",
            Some(&oversized),
            None,
            None,
            Some("accepted")
        )
        .is_err());
    }

    fn runtime_state(revision: &str, model_ids: &[&str]) -> RuntimeModelState {
        let (client, _agent) = xai_acp_lib::acp_channels();
        RuntimeModelState {
            initialized: true,
            revision: Some(revision.into()),
            model_ids: model_ids.iter().map(|id| (*id).into()).collect(),
            last_error: None,
            sender: Some(client.tx),
        }
    }

    #[test]
    fn runtime_readiness_requires_current_matching_snapshot() {
        let disk_models = vec!["model-a".to_string()];

        let unacknowledged = auth_status_from_snapshots(
            disk_models.clone(),
            None,
            "rev-a",
            RuntimeModelState::default(),
            false,
        );
        assert!(!unacknowledged.ready);
        assert!(!unacknowledged.runtime_ready);

        let stale_revision = auth_status_from_snapshots(
            disk_models.clone(),
            None,
            "rev-b",
            runtime_state("rev-a", &["model-a"]),
            true,
        );
        assert!(!stale_revision.ready);
        assert!(!stale_revision.synchronized);

        let retired_runtime = auth_status_from_snapshots(
            disk_models.clone(),
            None,
            "rev-a",
            runtime_state("rev-a", &["model-a"]),
            false,
        );
        assert!(!retired_runtime.ready);

        let synchronized = auth_status_from_snapshots(
            disk_models,
            None,
            "rev-a",
            runtime_state("rev-a", &["model-a", "runtime-default"]),
            true,
        );
        assert!(synchronized.ready);
        assert!(synchronized.synchronized);
        assert_eq!(
            validate_runtime_ready(&synchronized, Some("model-a")),
            Ok(())
        );
    }

    #[test]
    fn runtime_error_and_unavailable_requested_model_block_commands() {
        let mut failed = runtime_state("rev-a", &["model-a"]);
        failed.initialized = false;
        failed.last_error = Some("reload rejected".into());
        let failed_status =
            auth_status_from_snapshots(vec!["model-a".into()], None, "rev-a", failed, true);
        assert!(!failed_status.ready);
        assert!(failed_status
            .reason
            .as_deref()
            .unwrap()
            .contains("reload rejected"));
        assert!(validate_runtime_ready(&failed_status, None).is_err());

        let ready_status = auth_status_from_snapshots(
            vec!["model-a".into()],
            None,
            "rev-a",
            runtime_state("rev-a", &["model-a"]),
            true,
        );
        let error = validate_runtime_ready(&ready_status, Some("model-b")).unwrap_err();
        assert!(error.contains("model-b"));
    }

    /// A model that `[models]` hides or disables never reaches the Runtime's
    /// ACP catalog. Readiness must follow the Runtime's effective catalog, not a
    /// disk ⊆ runtime subset test, or one hidden model locks chat permanently.
    #[test]
    fn hidden_or_disabled_disk_model_does_not_block_readiness() {
        let status = auth_status_from_snapshots(
            vec!["model-a".into(), "model-hidden".into()],
            None,
            "rev-a",
            runtime_state("rev-a", &["model-a"]),
            true,
        );
        assert!(
            status.ready,
            "a filtered-out disk model must not block chat"
        );
        assert!(status.synchronized);
        assert_eq!(validate_runtime_ready(&status, Some("model-a")), Ok(()));
        // The filtered model is still correctly refused for a direct request.
        assert!(validate_runtime_ready(&status, Some("model-hidden")).is_err());
    }

    #[test]
    fn upstream_branded_ids_are_hidden_from_the_frontend() {
        let status = auth_status_from_snapshots(
            vec!["model-a".into(), "grok-4.6".into()],
            None,
            "rev-a",
            runtime_state("rev-a", &["model-a", "grok-4.6", "grok-4.5"]),
            true,
        );
        assert_eq!(status.providers, vec!["model-a".to_string()]);
        assert_eq!(status.runtime_models, vec!["model-a".to_string()]);
        assert_eq!(
            status.unfiltered_runtime_models,
            vec![
                "model-a".to_string(),
                "grok-4.6".to_string(),
                "grok-4.5".to_string()
            ],
            "authorization must still see the Runtime catalog verbatim"
        );
    }

    /// The display filter must never lock chat: readiness is computed from the
    /// unfiltered catalog, so a catalog of only branded ids still reads ready and
    /// those ids remain sendable. Otherwise a bundled-catalog fallback would take
    /// the app from "usable with an odd model name" to "cannot send at all".
    #[test]
    fn branded_id_filter_does_not_regress_readiness_or_authorization() {
        let status = auth_status_from_snapshots(
            vec!["grok-4.6".into()],
            None,
            "rev-a",
            runtime_state("rev-a", &["grok-4.6"]),
            true,
        );
        assert!(status.ready, "a display filter must not block chat");
        assert!(status.runtime_ready);
        assert!(status.runtime_models.is_empty(), "nothing branded is shown");
        assert_eq!(validate_runtime_ready(&status, Some("grok-4.6")), Ok(()));
    }

    /// A user's own connection whose id happens to contain a brand token stays
    /// fully functional — only its rendered label is replaced.
    #[test]
    fn user_model_matching_a_brand_token_is_still_sendable() {
        let status = auth_status_from_snapshots(
            vec!["my-grok-proxy".into()],
            None,
            "rev-a",
            runtime_state("rev-a", &["my-grok-proxy"]),
            true,
        );
        assert!(status.ready);
        assert_eq!(
            validate_runtime_ready(&status, Some("my-grok-proxy")),
            Ok(())
        );
    }

    #[test]
    fn brand_token_matching_is_case_insensitive_and_substring_based() {
        for id in [
            "grok-4.6",
            "Grok 4.5",
            "GROK",
            "xai-build",
            "x.ai/v1",
            "SpaceXAI",
        ] {
            assert!(is_upstream_branded_model_id(id), "{id} must be filtered");
        }
        for id in ["gpt-4o", "deepseek-chat", "qwen-max", "claude-sonnet-4"] {
            assert!(!is_upstream_branded_model_id(id), "{id} must be kept");
        }
    }

    /// An empty catalog is the signal that the Runtime rejected the reload or
    /// filtered everything out; it must not read as ready.
    #[test]
    fn empty_runtime_catalog_blocks_readiness() {
        let status = auth_status_from_snapshots(
            vec!["model-a".into()],
            None,
            "rev-a",
            runtime_state("rev-a", &[]),
            true,
        );
        assert!(!status.ready);
        assert!(!status.runtime_ready);
        assert!(
            status.synchronized,
            "revision did match; only the catalog is empty"
        );
        assert!(status.reason.as_deref().unwrap().contains("可用范围"));
    }

    #[test]
    fn orphaned_session_is_adopted_only_for_a_matching_request() {
        let state = AppState::default();
        state.record_orphaned_session(OrphanedSession {
            session_id: "session-1".into(),
            cwd: "/work".into(),
            model_id: Some("model-a".into()),
        });
        // Recording the same session twice must not duplicate it.
        state.record_orphaned_session(OrphanedSession {
            session_id: "session-1".into(),
            cwd: "/work".into(),
            model_id: Some("model-a".into()),
        });

        assert_eq!(state.take_orphaned_session("/other", Some("model-a")), None);
        assert_eq!(state.take_orphaned_session("/work", Some("model-b")), None);
        assert_eq!(state.take_orphaned_session("/work", None), None);
        assert_eq!(
            state.take_orphaned_session("/work", Some("model-a")),
            Some("session-1".to_string())
        );
        // Adopted once only.
        assert_eq!(state.take_orphaned_session("/work", Some("model-a")), None);
    }

    #[test]
    fn forged_session_cwd_is_rejected_without_expanding_filesystem_access() {
        let temp = tempfile::tempdir().unwrap();
        let trusted = temp.path().join("trusted");
        let forged = temp.path().join("forged");
        std::fs::create_dir_all(&trusted).unwrap();
        std::fs::create_dir_all(&forged).unwrap();
        let filesystem = crate::shell_fs::FilesystemAccess::default();
        filesystem
            .authorize_workspace(&trusted.to_string_lossy())
            .unwrap();

        let error = authorized_session_cwd(&filesystem, &forged.to_string_lossy()).unwrap_err();
        assert!(error.contains("未经用户授权"));
        // Validation is non-mutating: a second attempt is still rejected.
        assert!(authorized_session_cwd(&filesystem, &forged.to_string_lossy()).is_err());
    }

    #[test]
    fn native_selected_workspace_is_accepted_for_new_sessions() {
        let workspace = tempfile::tempdir().unwrap();
        let filesystem = crate::shell_fs::FilesystemAccess::default();
        let canonical = filesystem
            .authorize_workspace(&workspace.path().to_string_lossy())
            .unwrap();

        assert_eq!(
            authorized_session_cwd(&filesystem, &workspace.path().to_string_lossy()).unwrap(),
            canonical.to_string_lossy().into_owned()
        );
    }

    #[test]
    fn restored_trusted_workspace_is_accepted_for_loaded_sessions() {
        let workspace = tempfile::tempdir().unwrap();
        // `FilesystemAccess::new` feeds durable session/knowledge roots through
        // this same native-only registration method during startup.
        let restored = crate::shell_fs::FilesystemAccess::default();
        let persisted_canonical = restored
            .authorize_workspace(&workspace.path().to_string_lossy())
            .unwrap();

        assert_eq!(
            authorized_session_cwd(&restored, &workspace.path().to_string_lossy()).unwrap(),
            persisted_canonical.to_string_lossy().into_owned()
        );
    }

    #[test]
    fn init_generation_guards_stale_cleanup() {
        let state = AppState::default();
        let first = state.begin_init_generation();
        let second = state.begin_init_generation();
        assert!(second > first);
        assert!(!state.is_current_generation(first));
        assert!(state.is_current_generation(second));

        // A superseded generation's failure cleanup must leave the current
        // runtime state untouched.
        let (client, _agent) = xai_acp_lib::acp_channels();
        *state.tx.lock().unwrap() = Some(client.tx.clone());
        state.mark_runtime_models_synced(&client.tx, "rev-a".into(), vec!["model-a".into()]);
        clear_runtime_after_init_failure(&state, first);
        assert!(state.runtime_models.lock().unwrap().initialized);
        assert!(state.tx.lock().unwrap().is_some());

        clear_runtime_after_init_failure(&state, second);
        assert!(!state.runtime_models.lock().unwrap().initialized);
        assert!(state.tx.lock().unwrap().is_none());
    }

    /// A retired runtime's thread exit must not report the replacement as dead.
    #[test]
    fn agent_death_from_a_retired_runtime_is_not_reported() {
        let state = AppState::default();
        let (retired, _retired_agent) = xai_acp_lib::acp_channels();
        let (current, _current_agent) = xai_acp_lib::acp_channels();
        *state.tx.lock().unwrap() = Some(current.tx.clone());
        state.mark_runtime_models_synced(&current.tx, "rev-a".into(), vec!["model-a".into()]);

        assert!(!state.mark_runtime_dead_if_current(&retired.tx, "old thread exited"));
        assert!(state.runtime_models.lock().unwrap().initialized);

        assert!(state.mark_runtime_dead_if_current(&current.tx, "current thread exited"));
        assert!(!state.runtime_models.lock().unwrap().initialized);
    }
}
