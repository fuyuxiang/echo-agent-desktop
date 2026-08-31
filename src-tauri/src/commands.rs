//! Tauri command table — the frontend↔Rust contract.
//!
//! Commands are declared with `#[tauri::command]` and registered in lib.rs.
//! They drive the in-process EchoAgent runtime (see agent_runtime.rs) and bridge streamed
//! events back via Tauri events (see bridge.rs).

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Emitter, State};

use crate::agent_runtime::{self, AgentHandle, InitOutcome};
use crate::bridge::{PermissionOutcome, Permissions, QuestionOutcome, Questions};
use crate::sessions::{self, SessionSummary, WorkspaceInfo};

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
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub ready: bool,
    pub reason: Option<String>,
    /// Model ids configured in `~/.echo-agent/config.toml`. When non-empty the
    /// app can route prompts to the matching `[model.*]` backend.
    pub providers: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitResult {
    pub ok: bool,
    pub auth: AuthStatus,
    pub cwd: String,
    pub agent_version: Option<String>,
    pub default_model_id: Option<String>,
}

fn default_cwd() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// Initialize the in-process EchoAgent runtime. Spawns the agent thread, runs
/// `initialize`, and starts the dispatcher.
#[tauri::command]
pub async fn agent_init(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    permissions: State<'_, Permissions>,
    questions: State<'_, Questions>,
    cwd: Option<String>,
) -> Result<InitResult, String> {
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

    let cwd = cwd.map(PathBuf::from).unwrap_or_else(default_cwd);
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
    crate::bridge::spawn_dispatcher(app.clone(), rx, permissions.share(), questions.share());

    // Monitor the agent thread: if it exits unexpectedly (panic/crash), notify
    // the frontend so it can show a "restart agent" prompt instead of hanging.
    if let Some(join_handle) = thread {
        let monitor_app = app.clone();
        let monitor_cancel = cancel.clone();
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
            tracing::error!(reason = %reason, "EchoAgent runtime thread died");
            let _ = monitor_app.emit(
                "agent://agent-died",
                serde_json::json!({ "reason": reason }),
            );
        });
    }

    // Keep the cancel token so the agent thread can be stopped at shutdown.
    // (The rx half is now owned by the dispatcher; we hold only tx + cancel.)
    let (_placeholder_tx, placeholder_rx) =
        tokio::sync::mpsc::unbounded_channel::<xai_acp_lib::AcpClientMessage>();
    *state.handle.lock().unwrap() = Some(AgentHandle {
        tx,
        // Unused placeholder rx — the real rx lives in the dispatcher.
        rx: placeholder_rx,
        cancel,
        thread: None,
    });

    // Run the ACP initialization lifecycle. Provider credentials are managed
    // solely through the model-provider configuration.
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent channel not ready")?;

    let init_outcome: InitOutcome = agent_runtime::initialize(&tx)
        .await
        .map_err(|e| format!("initialize: {e}"))?;

    let list = crate::providers::providers_list();
    let model_ids: Vec<String> = list.models.iter().map(|m| m.model_id.clone()).collect();
    let ready = !model_ids.is_empty();

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
        auth: AuthStatus {
            ready,
            providers: model_ids,
            reason: if ready {
                None
            } else {
                Some("No model provider configured. Add one in Settings → 模型.".into())
            },
        },
        cwd: cwd.to_string_lossy().into_owned(),
        agent_version: init_outcome.agent_version,
        default_model_id: init_outcome.default_model_id,
    })
}

#[tauri::command]
pub fn agent_auth_status(_state: State<'_, AppState>) -> AuthStatus {
    let list = crate::providers::providers_list();
    let model_ids: Vec<String> = list.models.iter().map(|m| m.model_id.clone()).collect();
    let ready = !model_ids.is_empty();
    AuthStatus {
        ready,
        providers: model_ids,
        reason: if ready {
            None
        } else {
            Some("No model provider configured. Add one in Settings → 模型.".into())
        },
    }
}

#[tauri::command]
pub async fn agent_new_session(
    state: State<'_, AppState>,
    cwd: String,
    model_id: Option<String>,
) -> Result<String, String> {
    crate::policy::require_feature("sessions")?;
    crate::org::enforce_skill_lease();
    if let Some(model_id) = model_id.as_deref() {
        crate::policy::require_model(model_id)?;
    }
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    let session_id = agent_runtime::new_session(&tx, &PathBuf::from(cwd), model_id.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    // Team MCP server 已随 new_session 参数注入本会话；这里再异步持久化到
    // config.toml（一次即可），让 load_session 恢复的会话也能用。
    crate::team_mcp::persist_registration(&tx, &session_id);
    crate::org_mcp::persist_registration(&tx, &session_id);
    Ok(session_id)
}

#[tauri::command]
pub async fn agent_load_session(
    state: State<'_, AppState>,
    session_id: String,
    cwd: String,
) -> Result<(), String> {
    crate::org::enforce_skill_lease();
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    agent_runtime::load_session(&tx, &session_id, &PathBuf::from(cwd))
        .await
        .map_err(|e| e.to_string())?;
    // 恢复的会话从 config.toml 读 MCP 列表 —— 若端口较上次运行漂移，这里
    // 的 upsert 会用当前 URL 刷新并 live 重连（EchoAgent 的 toggle 路径）。
    crate::team_mcp::persist_registration(&tx, &session_id);
    crate::org_mcp::persist_registration(&tx, &session_id);
    Ok(())
}

#[tauri::command]
pub fn agent_list_sessions(cwd: String) -> Vec<SessionSummary> {
    sessions::list_sessions(&cwd)
}

#[tauri::command]
pub async fn agent_send(
    state: State<'_, AppState>,
    session_id: String,
    text: String,
    attachments: Option<Vec<String>>,
) -> Result<(), String> {
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    agent_runtime::prompt_with_attachments(
        &tx,
        &session_id,
        &text,
        attachments.as_deref().unwrap_or(&[]),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_cancel(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
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
pub async fn agent_shutdown(state: State<'_, AppState>) -> Result<(), String> {
    // Trigger the cancel token so the agent thread's `cancelled().await` resolves.
    if let Some(handle) = state.handle.lock().unwrap().take() {
        handle.cancel.cancel();
    }
    state.tx.lock().unwrap().take();
    if let Some(scheduler) = state.automation_scheduler.lock().unwrap().take() {
        scheduler.abort();
    }
    crate::automations::clear_runtime_sessions();
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

/// Resolve a pending question request from the frontend.
///
/// Wire contract for EchoAgent's `AskUserQuestionExtResponse`:
/// - `cancelled: true` → `{ "outcome": "cancelled" }`
/// - otherwise → `{ "outcome": "accepted", "answers": {...}, "annotations"?: {...} }`
///
/// `answers` must be keyed by **question text** (not synthetic id). Values may
/// be a string or a list of strings (multi-select). Freeform answers use
/// label `"Other"` with the typed text in `annotations[question].notes`.
#[tauri::command]
pub async fn agent_resolve_question(
    questions: State<'_, Questions>,
    request_id: String,
    answers: Option<std::collections::HashMap<String, serde_json::Value>>,
    annotations: Option<std::collections::HashMap<String, QuestionAnnotationDto>>,
    cancelled: Option<bool>,
) -> Result<bool, String> {
    let outcome = if cancelled.unwrap_or(false) {
        QuestionOutcome::Cancelled
    } else if let Some(raw_answers) = answers {
        let mut normalized = std::collections::HashMap::new();
        for (k, v) in raw_answers {
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
    } else {
        QuestionOutcome::Cancelled
    };
    Ok(questions.resolve(&request_id, outcome).await)
}

/// DTO for per-question annotations from the frontend.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionAnnotationDto {
    pub preview: Option<String>,
    pub notes: Option<String>,
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
    crate::policy::require_model(&model_id)?;
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
pub fn agent_list_workspaces() -> Vec<WorkspaceInfo> {
    sessions::list_workspaces()
}

/// Rename a session via EchoAgent's `echo.agent/session/rename` extension method. On
/// success EchoAgent also broadcasts `SessionSummaryGenerated`, which our bridge
/// forwards as the `agent://summary` event — so the frontend will receive the
/// new title twice (once from this return, once from the event). That's fine:
/// both arrive at the same store `upsert` and are idempotent.
#[tauri::command]
pub async fn agent_rename_session(
    state: State<'_, AppState>,
    session_id: String,
    title: String,
    cwd: Option<String>,
) -> Result<(), String> {
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    agent_runtime::rename_session(&tx, &session_id, &title, cwd.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Delete a session's persisted history via EchoAgent's `echo.agent/session/delete`.
/// Removes the on-disk session directory; the frontend drops its sidebar
/// entry on success.
#[tauri::command]
pub async fn agent_delete_session(
    state: State<'_, AppState>,
    session_id: String,
    cwd: Option<String>,
) -> Result<(), String> {
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    agent_runtime::delete_session(&tx, &session_id, cwd.as_deref())
        .await
        .map_err(|e| e.to_string())
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
    session_id: String,
    expert_id: String,
    expert_name: String,
    source: String,
    avatar_local: Option<String>,
) -> Result<bool, String> {
    crate::meta::set_expert(
        &session_id,
        crate::meta::ExpertBinding {
            expert_id,
            expert_name,
            source,
            avatar_local,
        },
    )
}

/// Remove the expert binding from a session. Returns `true` if a binding was removed.
#[tauri::command]
pub fn agent_clear_session_expert(session_id: String) -> Result<bool, String> {
    crate::meta::clear_expert(&session_id)
}
