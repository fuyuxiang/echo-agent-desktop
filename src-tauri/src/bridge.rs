//! ACP → Tauri bridge.
//!
//! A long-lived task drains `AgentHandle.rx` (the agent→client channel) and:
//!  - `SessionNotification` → serialize the SessionUpdate, emit `agent://update`,
//!    then ack the oneshot (agent future hangs otherwise);
//!  - `RequestPermission` → register a pending permission in `Permissions`,
//!    emit `agent://permission` (the frontend resolves via a command);
//!  - `ExtNotification("echo.agent/session/prompt_complete")` → emit `agent://complete`;
//!  - fs/terminal requests → never arrive (we advertised no capability); if
//!    they do, we deny so the agent future still completes.

use std::collections::HashMap;
use std::sync::Arc;

use agent_client_protocol as acp;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

use xai_acp_lib::AcpClientMessage;

const MAX_PENDING_INTERACTIONS: usize = 64;
const MAX_EXT_METHOD_PARAMS_BYTES: usize = 256 * 1024;
const MAX_INTERACTION_ID_CHARS: usize = 256;
const MAX_INTERACTION_TEXT_CHARS: usize = 4_096;
const MAX_INTERACTION_TITLE_CHARS: usize = 512;
const MAX_PERMISSION_OPTIONS: usize = 16;
const MAX_PERMISSION_RAW_INPUT_BYTES: usize = 64 * 1024;
const MAX_QUESTION_ITEMS: usize = 12;
const MAX_QUESTION_OPTIONS: usize = 16;
const MAX_QUESTION_OPTION_TEXT_CHARS: usize = 1_024;
const MAX_QUESTION_TIMEOUT_SECS: u64 = 24 * 60 * 60;
const MAX_FOLDER_TRUST_CONFIG_KINDS: usize = 32;
const MAX_FOLDER_TRUST_PATH_CHARS: usize = 4_096;

/// Registry of permissions awaiting a user decision. The frontend calls the
/// `agent_resolve_permission` command, which looks up the entry by id and
/// fulfills the oneshot the agent is waiting on.
#[derive(Default, Clone)]
pub struct Permissions {
    inner: Arc<Mutex<Vec<PendingPermission>>>,
}

/// Registry of questions awaiting a user answer. The frontend calls the
/// `agent_resolve_question` command, which looks up the entry by id and
/// fulfills the oneshot the agent is waiting on.
#[derive(Default, Clone)]
pub struct Questions {
    inner: Arc<Mutex<Vec<PendingQuestion>>>,
}

/// Typed registry for `echo.agent/exit_plan_mode` reverse requests.
#[derive(Default, Clone)]
pub struct PlanApprovals {
    inner: Arc<Mutex<Vec<PendingPlanApproval>>>,
}

/// Typed registry for `echo.agent/folder_trust/request` reverse requests.
#[derive(Default, Clone)]
pub struct FolderTrusts {
    inner: Arc<Mutex<Vec<PendingFolderTrust>>>,
}

struct PendingPermission {
    request: PermissionFrontend,
    response_tx: oneshot::Sender<PermissionOutcome>,
}

struct PendingQuestion {
    request: QuestionFrontend,
    response_tx: oneshot::Sender<QuestionOutcome>,
}

struct PendingPlanApproval {
    request: PlanApprovalFrontend,
    response_tx: oneshot::Sender<PlanApprovalOutcome>,
}

struct PendingFolderTrust {
    request: FolderTrustFrontend,
    response_tx: oneshot::Sender<FolderTrustOutcome>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionFrontend {
    pub request_id: String,
    pub session_id: String,
    pub tool_call_id: String,
    pub title: String,
    pub questions: Vec<QuestionItem>,
    pub mode: QuestionMode,
    pub timeout: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct QuestionClosedFrontend {
    request_id: String,
    session_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionItem {
    pub id: String,
    pub question: String,
    pub options: Vec<QuestionOptionFrontend>,
    pub multi_select: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOptionFrontend {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub label: String,
    #[serde(default)]
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QuestionMode {
    #[default]
    Default,
    Plan,
}

/// Frontend → bridge outcome for an `ask_user_question` reverse-request.
///
/// The wire format sent back to EchoAgent must match
/// `AskUserQuestionExtResponse` (internally tagged on `"outcome"`,
/// snake_case variants): e.g. `{"outcome":"accepted","answers":{...}}`.
pub enum QuestionOutcome {
    /// User accepted. `answers` is keyed by **question text** (not id);
    /// values are selected option labels (or `"Other"` for freeform).
    /// `annotations` carries freeform notes / previews keyed the same way.
    Accepted {
        answers: HashMap<String, Vec<String>>,
        annotations: Option<HashMap<String, QuestionAnnotation>>,
    },
    ChatAboutThis {
        partial_answers: HashMap<String, String>,
    },
    SkipInterview {
        partial_answers: HashMap<String, String>,
    },
    Cancelled,
}

#[derive(Clone, Debug, Serialize)]
pub struct QuestionAnnotation {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionFrontend {
    pub request_id: String,
    pub session_id: String,
    pub tool_call_id: String,
    pub tool_kind: String,
    pub title: String,
    pub raw_input: Option<Value>,
    pub options: Vec<PermissionOptionFrontend>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOptionFrontend {
    pub option_id: String,
    pub kind: String,
    pub title: String,
}

pub enum PermissionOutcome {
    Selected(String), // optionId
    Cancelled,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanApprovalFrontend {
    pub request_id: String,
    pub session_id: String,
    pub tool_call_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_content: Option<String>,
}

pub enum PlanApprovalOutcome {
    Approved,
    Cancelled { feedback: Option<String> },
    Abandoned,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTrustFrontend {
    pub request_id: String,
    pub session_id: String,
    pub cwd: String,
    pub workspace: String,
    pub config_kinds: Vec<String>,
}

pub enum FolderTrustOutcome {
    Trust,
    Reject,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanApprovalWireRequest {
    session_id: String,
    tool_call_id: String,
    #[serde(default)]
    plan_content: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FolderTrustWireRequest {
    session_id: String,
    cwd: String,
    workspace: String,
    #[serde(default)]
    config_kinds: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuestionWireRequest {
    session_id: String,
    tool_call_id: String,
    #[serde(default)]
    title: Option<String>,
    questions: Vec<QuestionWireItem>,
    #[serde(default)]
    mode: QuestionMode,
    // The Runtime propagates the tool's wait budget as `timeoutSecs`. Accept
    // the legacy `timeout` spelling too so the renderer always shows the same
    // authoritative countdown as the pending backend request.
    #[serde(default, alias = "timeoutSecs")]
    timeout: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuestionWireItem {
    #[serde(default)]
    id: Option<String>,
    question: String,
    #[serde(default, alias = "answers")]
    options: Vec<QuestionWireOption>,
    #[serde(default, alias = "multi_select")]
    multi_select: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum QuestionWireOption {
    Label(String),
    Detailed {
        #[serde(default)]
        id: Option<String>,
        #[serde(alias = "option")]
        label: String,
        #[serde(default)]
        description: String,
        #[serde(default)]
        preview: Option<String>,
    },
}

/// Replayable snapshot used when the renderer subscribes after an interaction
/// was emitted. Vectors retain arrival order, so each per-session UI can queue
/// deterministically instead of overwriting an older request.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingInteractionsFrontend {
    pub permissions: Vec<PermissionFrontend>,
    pub questions: Vec<QuestionFrontend>,
    pub plan_approvals: Vec<PlanApprovalFrontend>,
    pub folder_trust_requests: Vec<FolderTrustFrontend>,
}

impl Permissions {
    pub fn new() -> Self {
        Self::default()
    }

    /// Cheap clone (inner is `Arc<Mutex<..>>`). Used to hand the registry
    /// to the dispatcher from a `State<Permissions>` without moving it out.
    pub fn share(&self) -> Permissions {
        Permissions {
            inner: self.inner.clone(),
        }
    }

    /// Register a pending permission; returns the id and the receiver the
    /// dispatcher awaits (then forwards back to the agent).
    pub async fn register(
        &self,
        request: PermissionFrontend,
    ) -> Result<oneshot::Receiver<PermissionOutcome>, &'static str> {
        let (tx, rx) = oneshot::channel();
        let mut pending = self.inner.lock().await;
        if pending.len() >= MAX_PENDING_INTERACTIONS {
            return Err("too many pending permission requests");
        }
        pending.push(PendingPermission {
            request,
            response_tx: tx,
        });
        Ok(rx)
    }

    /// Called by the `agent_resolve_permission` command.
    pub async fn resolve(&self, id: &str, outcome: PermissionOutcome) -> bool {
        let mut pending = self.inner.lock().await;
        if let Some(index) = pending
            .iter()
            .position(|entry| entry.request.request_id == id)
        {
            let entry = pending.remove(index);
            let _ = entry.response_tx.send(outcome);
            true
        } else {
            false
        }
    }

    pub async fn discard(&self, id: &str) {
        self.inner
            .lock()
            .await
            .retain(|entry| entry.request.request_id != id);
    }

    pub async fn list(&self, session_id: Option<&str>) -> Vec<PermissionFrontend> {
        self.inner
            .lock()
            .await
            .iter()
            .filter(|entry| session_id.is_none_or(|sid| entry.request.session_id == sid))
            .map(|entry| entry.request.clone())
            .collect()
    }

    pub async fn cancel_all(&self) {
        let entries = std::mem::take(&mut *self.inner.lock().await);
        for entry in entries {
            let _ = entry.response_tx.send(PermissionOutcome::Cancelled);
        }
    }
}

impl Questions {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn share(&self) -> Questions {
        Questions {
            inner: self.inner.clone(),
        }
    }

    pub async fn register(
        &self,
        request: QuestionFrontend,
    ) -> Result<oneshot::Receiver<QuestionOutcome>, &'static str> {
        let (tx, rx) = oneshot::channel();
        let mut pending = self.inner.lock().await;
        if pending.len() >= MAX_PENDING_INTERACTIONS {
            return Err("too many pending question requests");
        }
        pending.push(PendingQuestion {
            request,
            response_tx: tx,
        });
        Ok(rx)
    }

    pub async fn resolve(&self, id: &str, outcome: QuestionOutcome) -> bool {
        let mut pending = self.inner.lock().await;
        if let Some(index) = pending
            .iter()
            .position(|entry| entry.request.request_id == id)
        {
            let entry = pending.remove(index);
            let _ = entry.response_tx.send(outcome);
            true
        } else {
            false
        }
    }

    pub async fn discard(&self, id: &str) {
        self.inner
            .lock()
            .await
            .retain(|entry| entry.request.request_id != id);
    }

    pub async fn list(&self, session_id: Option<&str>) -> Vec<QuestionFrontend> {
        self.inner
            .lock()
            .await
            .iter()
            .filter(|entry| session_id.is_none_or(|sid| entry.request.session_id == sid))
            .map(|entry| entry.request.clone())
            .collect()
    }

    pub async fn cancel_all(&self) {
        let entries = std::mem::take(&mut *self.inner.lock().await);
        for entry in entries {
            let _ = entry.response_tx.send(QuestionOutcome::Cancelled);
        }
    }
}

impl PlanApprovals {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn share(&self) -> Self {
        self.clone()
    }

    pub async fn register(
        &self,
        request: PlanApprovalFrontend,
    ) -> Result<oneshot::Receiver<PlanApprovalOutcome>, &'static str> {
        let (tx, rx) = oneshot::channel();
        let mut pending = self.inner.lock().await;
        if pending.len() >= MAX_PENDING_INTERACTIONS {
            return Err("too many pending plan approval requests");
        }
        pending.push(PendingPlanApproval {
            request,
            response_tx: tx,
        });
        Ok(rx)
    }

    pub async fn resolve(&self, id: &str, outcome: PlanApprovalOutcome) -> bool {
        let mut pending = self.inner.lock().await;
        if let Some(index) = pending
            .iter()
            .position(|entry| entry.request.request_id == id)
        {
            let entry = pending.remove(index);
            let _ = entry.response_tx.send(outcome);
            true
        } else {
            false
        }
    }

    pub async fn discard(&self, id: &str) {
        self.inner
            .lock()
            .await
            .retain(|entry| entry.request.request_id != id);
    }

    pub async fn list(&self, session_id: Option<&str>) -> Vec<PlanApprovalFrontend> {
        self.inner
            .lock()
            .await
            .iter()
            .filter(|entry| session_id.is_none_or(|sid| entry.request.session_id == sid))
            .map(|entry| entry.request.clone())
            .collect()
    }

    pub async fn cancel_all(&self) {
        let entries = std::mem::take(&mut *self.inner.lock().await);
        for entry in entries {
            let _ = entry
                .response_tx
                .send(PlanApprovalOutcome::Cancelled { feedback: None });
        }
    }
}

impl FolderTrusts {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn share(&self) -> Self {
        self.clone()
    }

    pub async fn register(
        &self,
        request: FolderTrustFrontend,
    ) -> Result<oneshot::Receiver<FolderTrustOutcome>, &'static str> {
        let (tx, rx) = oneshot::channel();
        let mut pending = self.inner.lock().await;
        if pending.len() >= MAX_PENDING_INTERACTIONS {
            return Err("too many pending folder trust requests");
        }
        pending.push(PendingFolderTrust {
            request,
            response_tx: tx,
        });
        Ok(rx)
    }

    pub async fn resolve(&self, id: &str, outcome: FolderTrustOutcome) -> bool {
        let mut pending = self.inner.lock().await;
        if let Some(index) = pending
            .iter()
            .position(|entry| entry.request.request_id == id)
        {
            let entry = pending.remove(index);
            let _ = entry.response_tx.send(outcome);
            true
        } else {
            false
        }
    }

    pub async fn discard(&self, id: &str) {
        self.inner
            .lock()
            .await
            .retain(|entry| entry.request.request_id != id);
    }

    pub async fn list(&self, session_id: Option<&str>) -> Vec<FolderTrustFrontend> {
        self.inner
            .lock()
            .await
            .iter()
            .filter(|entry| session_id.is_none_or(|sid| entry.request.session_id == sid))
            .map(|entry| entry.request.clone())
            .collect()
    }

    pub async fn cancel_all(&self) {
        let entries = std::mem::take(&mut *self.inner.lock().await);
        for entry in entries {
            let _ = entry.response_tx.send(FolderTrustOutcome::Reject);
        }
    }
}

pub fn new_interaction_id() -> String {
    Uuid::now_v7().to_string()
}

fn validate_required_text(value: &str, max_chars: usize, field: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{field} is required"));
    }
    if value.chars().count() > max_chars || value.chars().any(|character| character == '\0') {
        return Err(format!("{field} is invalid or too long"));
    }
    Ok(())
}

fn optional_display_text(value: Option<String>, max_chars: usize) -> Option<String> {
    value
        .map(|value| bounded_display_text(&value, max_chars))
        .filter(|value| !value.trim().is_empty())
}

fn bounded_display_text(value: &str, max_chars: usize) -> String {
    let mut output = String::new();
    let mut truncated = false;
    let mut chars = 0usize;
    for character in value.chars() {
        if character == '\0' {
            truncated = true;
            continue;
        }
        if chars >= max_chars {
            truncated = true;
            break;
        }
        output.push(character);
        chars = chars.saturating_add(1);
    }
    if truncated {
        output.push_str("\n[truncated]");
    }
    output
}

fn capped_json_for_frontend(value: Option<&Value>) -> Option<Value> {
    let value = value?;
    let mut budget = MAX_PERMISSION_RAW_INPUT_BYTES;
    let mut truncated = false;
    let candidate = bounded_json_value(value, &mut budget, 0, &mut truncated);
    if !truncated {
        if let Ok(encoded) = serde_json::to_vec(&candidate) {
            if encoded.len() <= MAX_PERMISSION_RAW_INPUT_BYTES {
                return Some(candidate);
            }
        }
    }
    Some(serde_json::json!({
        "_truncated": true,
        "message": "Permission input omitted because it exceeded the UI safety limit"
    }))
}

fn bounded_json_value(
    value: &Value,
    budget: &mut usize,
    depth: usize,
    truncated: &mut bool,
) -> Value {
    if *budget == 0 || depth >= 8 {
        *truncated = true;
        return Value::String("[truncated]".into());
    }
    match value {
        Value::Null => Value::Null,
        Value::Bool(value) => {
            *budget = budget.saturating_sub(5);
            Value::Bool(*value)
        }
        Value::Number(value) => {
            *budget = budget.saturating_sub(value.to_string().len());
            Value::Number(value.clone())
        }
        Value::String(value) => {
            let max_chars = MAX_INTERACTION_TEXT_CHARS.min(*budget);
            let bounded = bounded_display_text(value, max_chars);
            if bounded.len() < value.len() {
                *truncated = true;
            }
            *budget = budget.saturating_sub(bounded.len());
            Value::String(bounded)
        }
        Value::Array(items) => {
            if items.len() > 64 {
                *truncated = true;
            }
            Value::Array(
                items
                    .iter()
                    .take(64)
                    .map(|item| bounded_json_value(item, budget, depth + 1, truncated))
                    .collect(),
            )
        }
        Value::Object(items) => {
            if items.len() > 64 {
                *truncated = true;
            }
            let mut out = serde_json::Map::new();
            for (key, item) in items.iter().take(64) {
                let key = bounded_display_text(key, MAX_INTERACTION_TITLE_CHARS);
                *budget = budget.saturating_sub(key.len());
                out.insert(key, bounded_json_value(item, budget, depth + 1, truncated));
            }
            Value::Object(out)
        }
    }
}

fn question_frontend_from_wire(request: QuestionWireRequest) -> Result<QuestionFrontend, String> {
    validate_required_text(
        &request.session_id,
        MAX_INTERACTION_ID_CHARS,
        "question sessionId",
    )?;
    validate_required_text(
        &request.tool_call_id,
        MAX_INTERACTION_ID_CHARS,
        "question toolCallId",
    )?;
    if request.questions.is_empty() || request.questions.len() > MAX_QUESTION_ITEMS {
        return Err(format!(
            "question request must contain 1..={MAX_QUESTION_ITEMS} questions"
        ));
    }

    let mut items = Vec::with_capacity(request.questions.len());
    for (index, question) in request.questions.into_iter().enumerate() {
        validate_required_text(
            &question.question,
            MAX_INTERACTION_TEXT_CHARS,
            "question text",
        )?;
        if question.options.len() > MAX_QUESTION_OPTIONS {
            return Err(format!(
                "question options cannot exceed {MAX_QUESTION_OPTIONS}"
            ));
        }
        let mut options = Vec::with_capacity(question.options.len());
        for option in question.options {
            let option = match option {
                QuestionWireOption::Label(label) => {
                    validate_required_text(
                        &label,
                        MAX_QUESTION_OPTION_TEXT_CHARS,
                        "question option label",
                    )?;
                    QuestionOptionFrontend {
                        id: None,
                        label,
                        description: String::new(),
                        preview: None,
                    }
                }
                QuestionWireOption::Detailed {
                    id,
                    label,
                    description,
                    preview,
                } => {
                    validate_required_text(
                        &label,
                        MAX_QUESTION_OPTION_TEXT_CHARS,
                        "question option label",
                    )?;
                    let id = id.filter(|id| {
                        !id.trim().is_empty()
                            && id.chars().count() <= MAX_INTERACTION_ID_CHARS
                            && !id.chars().any(|character| character == '\0')
                    });
                    QuestionOptionFrontend {
                        id,
                        label,
                        description: bounded_display_text(
                            &description,
                            MAX_INTERACTION_TITLE_CHARS,
                        ),
                        preview: optional_display_text(preview, MAX_INTERACTION_TITLE_CHARS),
                    }
                }
            };
            options.push(option);
        }
        let id = question
            .id
            .filter(|id| {
                !id.trim().is_empty()
                    && id.chars().count() <= MAX_INTERACTION_ID_CHARS
                    && !id.chars().any(|character| character == '\0')
            })
            .unwrap_or_else(|| format!("q-{index}"));
        items.push(QuestionItem {
            id,
            question: question.question,
            options,
            multi_select: question.multi_select.unwrap_or(false),
        });
    }

    let title = optional_display_text(request.title, MAX_INTERACTION_TITLE_CHARS)
        .or_else(|| items.first().map(|item| item.question.clone()))
        .unwrap_or_else(|| "Agent 提问".into());

    Ok(QuestionFrontend {
        request_id: new_interaction_id(),
        session_id: request.session_id,
        tool_call_id: request.tool_call_id,
        title,
        questions: items,
        mode: request.mode,
        timeout: request
            .timeout
            .map(|timeout| timeout.min(MAX_QUESTION_TIMEOUT_SECS)),
    })
}

fn plan_frontend_from_wire(
    request: PlanApprovalWireRequest,
) -> Result<PlanApprovalFrontend, String> {
    validate_required_text(
        &request.session_id,
        MAX_INTERACTION_ID_CHARS,
        "plan sessionId",
    )?;
    validate_required_text(
        &request.tool_call_id,
        MAX_INTERACTION_ID_CHARS,
        "plan toolCallId",
    )?;
    Ok(PlanApprovalFrontend {
        request_id: new_interaction_id(),
        session_id: request.session_id,
        tool_call_id: request.tool_call_id,
        plan_content: optional_display_text(request.plan_content, MAX_PERMISSION_RAW_INPUT_BYTES),
    })
}

fn folder_trust_frontend_from_wire(
    request: FolderTrustWireRequest,
) -> Result<FolderTrustFrontend, String> {
    validate_required_text(
        &request.session_id,
        MAX_INTERACTION_ID_CHARS,
        "folder trust sessionId",
    )?;
    validate_required_text(
        &request.cwd,
        MAX_FOLDER_TRUST_PATH_CHARS,
        "folder trust cwd",
    )?;
    validate_required_text(
        &request.workspace,
        MAX_FOLDER_TRUST_PATH_CHARS,
        "folder trust workspace",
    )?;
    if request.config_kinds.len() > MAX_FOLDER_TRUST_CONFIG_KINDS {
        return Err(format!(
            "folder trust configKinds cannot exceed {MAX_FOLDER_TRUST_CONFIG_KINDS}"
        ));
    }
    for kind in &request.config_kinds {
        validate_required_text(
            kind,
            MAX_INTERACTION_TITLE_CHARS,
            "folder trust config kind",
        )?;
    }
    Ok(FolderTrustFrontend {
        request_id: new_interaction_id(),
        session_id: request.session_id,
        cwd: request.cwd,
        workspace: request.workspace,
        config_kinds: request.config_kinds,
    })
}

pub async fn pending_interactions(
    permissions: &Permissions,
    questions: &Questions,
    plan_approvals: &PlanApprovals,
    folder_trusts: &FolderTrusts,
    session_id: Option<&str>,
) -> PendingInteractionsFrontend {
    let (permissions, questions, plan_approvals, folder_trust_requests) = tokio::join!(
        permissions.list(session_id),
        questions.list(session_id),
        plan_approvals.list(session_id),
        folder_trusts.list(session_id),
    );
    PendingInteractionsFrontend {
        permissions,
        questions,
        plan_approvals,
        folder_trust_requests,
    }
}

/// Payload emitted on the `agent://update` event — the raw SessionUpdate JSON,
/// plus the session id it belongs to (so the frontend can route updates for
/// side-channel sessions like inspiration generation away from the main
/// transcript store).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateEvent {
    /// Session id this update belongs to. `None` only if EchoAgent omitted it
    /// (shouldn't happen for SessionNotification). When present, the frontend
    /// checks it against the current session before applying.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(flatten)]
    pub update: Value,
}

/// Payload emitted on `agent://complete`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteEvent {
    pub session_id: String,
    pub stop_reason: String,
}

/// Exact per-prompt usage carried by EchoAgent's durable `TurnCompleted`
/// session update. Unlike `session/usage`, this is not a process-local
/// cumulative counter, so the frontend can persist and replay it idempotently
/// without assigning an old session's history to the current day.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnUsageEvent {
    pub session_id: String,
    pub prompt_id: String,
    pub usage: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub occurred_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
}

/// Payload emitted on `agent://turn-error` — a turn that ended abnormally
/// (`stopReason: "rate_limit" | "error"`). EchoAgent reports mid-stream failures
/// (e.g. a 429 hit while a tool was running) via `prompt_complete` with these
/// stop reasons rather than as a thrown error, so without this event the
/// frontend would silently mark the turn "complete" and the user would see no
/// explanation for why the agent stopped mid-task.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnErrorEvent {
    pub session_id: String,
    /// "rate_limit" | "error" (mirrors EchoAgent's `stop_reason_for_turn_error`).
    pub kind: String,
    /// Server-provided detail string (null for rate_limit — EchoAgent deliberately
    /// omits it so the client shows its own message). We forward it verbatim
    /// when present; the frontend decides how to render.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Payload emitted on `agent://summary` — a freshly generated (or manually
/// renamed) session title. The frontend updates the sidebar entry in place.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryEvent {
    pub session_id: String,
    pub title: String,
}

/// Payload emitted on `agent://subagent` — a live subagent lifecycle event
/// (spawned / progress / finished). EchoAgent sends these as
/// `echo.agent/session_notification` extension notifications addressed to the
/// parent session. We forward the relevant fields so the frontend can show
/// live subagent progress (turns, tokens, duration, status) — aligning with
/// EchoAgent's team-runtime panel.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentEvent {
    /// Parent session that owns the subagent.
    pub session_id: String,
    /// Lifecycle phase: "spawned" | "progress" | "finished".
    pub phase: String,
    /// Subagent unique id (= child session id).
    pub subagent_id: String,
    /// Child session's ACP session id (same as subagent_id for spawned/progress).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub child_session_id: Option<String>,
    /// Human-readable description / task title.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Agent type ("general-purpose", "explore", "plan", etc.).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subagent_type: Option<String>,
    /// Status: "running" (spawned/progress) or the finished status.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// Elapsed wall-clock time in ms.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Number of completed turns.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_count: Option<u32>,
    /// Total tool calls so far.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_count: Option<u32>,
    /// Current tokens used.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_used: Option<u64>,
    /// Context window capacity in tokens.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window_tokens: Option<u64>,
    /// Context window usage percentage (0-100).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_usage_pct: Option<u8>,
    /// Distinct tool names called so far.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools_used: Option<Vec<String>>,
    /// Error message (finished only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Final output text (finished only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
}

/// Spawn the dispatcher that forwards agent→client messages to the frontend.
pub fn spawn_dispatcher(
    app: AppHandle,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<AcpClientMessage>,
    permissions: Permissions,
    questions: Questions,
    plan_approvals: PlanApprovals,
    folder_trusts: FolderTrusts,
) {
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            handle_client_message(
                &app,
                msg,
                &permissions,
                &questions,
                &plan_approvals,
                &folder_trusts,
            )
            .await;
        }
        tracing::info!("EchoAgent agent channel closed");
    });
}

async fn handle_client_message(
    app: &AppHandle,
    msg: AcpClientMessage,
    perms: &Permissions,
    questions: &Questions,
    plan_approvals: &PlanApprovals,
    folder_trusts: &FolderTrusts,
) {
    match msg {
        AcpClientMessage::SessionNotification(b) => {
            let update = serialize_session_update(&b.request.update);
            let sid = b.request.session_id.0.as_ref().to_string();
            tracing::debug!(session_id = %sid, update = %update, "agent://update");
            let _ = app.emit(
                "agent://update",
                UpdateEvent {
                    session_id: Some(sid),
                    update,
                },
            );
            // ACK so the agent's notification future completes.
            let _ = b.response_tx.send(Ok(()));
        }
        AcpClientMessage::RequestPermission(b) => {
            let req = &b.request;
            let session_id_str = req.session_id.0.as_ref().to_string();
            if let Err(error) = validate_required_text(
                &session_id_str,
                MAX_INTERACTION_ID_CHARS,
                "permission sessionId",
            ) {
                tracing::warn!(%error, "malformed permission request; cancelling fail-closed");
                send_permission_cancelled(b.response_tx);
                return;
            }
            if req.options.is_empty() || req.options.len() > MAX_PERMISSION_OPTIONS {
                tracing::warn!(
                    options = req.options.len(),
                    "invalid permission options; cancelling fail-closed"
                );
                send_permission_cancelled(b.response_tx);
                return;
            }

            let mut options = Vec::with_capacity(req.options.len());
            for o in &req.options {
                let option_id = o.option_id.0.as_ref().to_string();
                if let Err(error) = validate_required_text(
                    &option_id,
                    MAX_INTERACTION_ID_CHARS,
                    "permission optionId",
                ) {
                    tracing::warn!(%error, "malformed permission request; cancelling fail-closed");
                    send_permission_cancelled(b.response_tx);
                    return;
                }
                options.push(PermissionOptionFrontend {
                    option_id,
                    kind: permission_kind_str(&o.kind).to_string(),
                    title: bounded_display_text(&o.name, MAX_INTERACTION_TITLE_CHARS),
                });
            }

            // Auto-approve: if the permission mode is "always-approve", pick the
            // first allow/allow_always option and respond immediately.
            let perm_mode = crate::permission_config::read_permission_mode();
            if perm_mode == "always-approve"
                || crate::automations::is_full_access_session(&session_id_str)
            {
                let auto_option = options
                    .iter()
                    .find(|o| o.kind == "allow" || o.kind == "allow_always");
                if let Some(opt) = auto_option {
                    let response = acp::RequestPermissionResponse::new(
                        acp::RequestPermissionOutcome::Selected(
                            acp::SelectedPermissionOutcome::new(acp::PermissionOptionId::new(
                                Arc::from(opt.option_id.as_str()),
                            )),
                        ),
                    );
                    tracing::info!(session_id = %session_id_str, "auto-approved permission (always-approve mode)");
                    let _ = b.response_tx.send(Ok(response));
                    return;
                }
                // 没有 allow 选项时不静默选择 first（那可能是 deny，会让工具莫名失败）。
                // 改为回退到下方正常的人工审批流程，把决定权交给用户。
                tracing::info!(
                    session_id = %session_id_str,
                    "always-approve mode but no allow option present — falling back to manual approval"
                );
            }

            // Extract tool metadata from the ACP ToolCallUpdate so the frontend
            // can display the tool kind, title, and raw input parameters.
            let tool_call_id = req.tool_call.tool_call_id.0.as_ref().to_string();
            if let Err(error) = validate_required_text(
                &tool_call_id,
                MAX_INTERACTION_ID_CHARS,
                "permission toolCallId",
            ) {
                tracing::warn!(%error, "malformed permission request; cancelling fail-closed");
                send_permission_cancelled(b.response_tx);
                return;
            }
            let tool_kind = req
                .tool_call
                .fields
                .kind
                .as_ref()
                .map(|k| format!("{k:?}").to_lowercase())
                .unwrap_or_default();
            let title = req
                .tool_call
                .fields
                .title
                .clone()
                .or_else(|| options.first().map(|o| o.title.clone()))
                .unwrap_or_else(|| "permission".into());
            let raw_input = capped_json_for_frontend(req.tool_call.fields.raw_input.as_ref());

            let frontend = PermissionFrontend {
                request_id: new_interaction_id(),
                session_id: session_id_str.clone(),
                tool_call_id,
                tool_kind: bounded_display_text(&tool_kind, MAX_INTERACTION_TITLE_CHARS),
                title: bounded_display_text(&title, MAX_INTERACTION_TITLE_CHARS),
                raw_input,
                options,
            };
            let request_id = frontend.request_id.clone();
            let rx = match perms.register(frontend.clone()).await {
                Ok(rx) => rx,
                Err(error) => {
                    tracing::warn!(%error, "permission queue full; cancelling fail-closed");
                    send_permission_cancelled(b.response_tx);
                    return;
                }
            };
            let emitted = app.emit("agent://permission", frontend).is_ok();
            if !emitted {
                // If the native event channel itself is unavailable, never
                // leave the agent parked on an interaction nobody can see.
                let _ = perms
                    .resolve(&request_id, PermissionOutcome::Cancelled)
                    .await;
            }
            let notify_app = app.clone();
            let notify_session = session_id_str.clone();
            tokio::spawn(async move {
                let _ = crate::notifications::dispatch_external(
                    &notify_app,
                    crate::notifications::NotifyMessage {
                        title: "EchoAgent 权限请求".into(),
                        body: Some("有工具等待你的授权".into()),
                        level: "warn".into(),
                        session_id: Some(notify_session),
                    },
                    None,
                )
                .await;
            });

            // Do not block the dispatcher: another session's updates and
            // interactions must continue flowing while this decision is open.
            let registry = perms.clone();
            let mut response_tx = b.response_tx;
            tokio::spawn(async move {
                let outcome = tokio::select! {
                    result = rx => result.unwrap_or(PermissionOutcome::Cancelled),
                    () = response_tx.closed() => {
                        registry.discard(&request_id).await;
                        return;
                    }
                };
                let response = match outcome {
                    PermissionOutcome::Selected(option_id) => acp::RequestPermissionResponse::new(
                        acp::RequestPermissionOutcome::Selected(
                            acp::SelectedPermissionOutcome::new(acp::PermissionOptionId::new(
                                Arc::from(option_id.as_str()),
                            )),
                        ),
                    ),
                    PermissionOutcome::Cancelled => acp::RequestPermissionResponse::new(
                        acp::RequestPermissionOutcome::Cancelled,
                    ),
                };
                let _ = response_tx.send(Ok(response));
            });
        }
        AcpClientMessage::ExtNotification(b) => {
            let method = b.request.method.as_ref().to_string();
            // params is a RawValue on the wire; deserialize to extract fields.
            let raw_str = b.request.params.get();
            let params: Value = serde_json::from_str(raw_str).unwrap_or(Value::Null);
            if method == "echo.agent/session/prompt_complete" {
                // Prompt finished: surface sessionId / stopReason to the frontend.
                let session_id = params
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let stop_reason = params
                    .get("stopReason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("end_turn")
                    .to_string();
                // EchoAgent reports mid-turn failures (429 hit while a tool was
                // running, connection reset, etc.) via prompt_complete with
                // stopReason "rate_limit" or "error" — NOT as a thrown error.
                // The `agent_result` field carries the server detail for
                // generic errors (null/absent for rate_limit). Forward both as
                // a dedicated `agent://turn-error` so the UI can surface a
                // friendly message instead of silently marking the turn done.
                if stop_reason == "rate_limit" || stop_reason == "error" {
                    let detail = params
                        .get("agent_result")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    tracing::info!(
                        session_id = %session_id,
                        stop_reason = %stop_reason,
                        detail,
                        "turn ended abnormally — emitting agent://turn-error"
                    );
                    let _ = app.emit(
                        "agent://turn-error",
                        TurnErrorEvent {
                            session_id: session_id.clone(),
                            kind: stop_reason.clone(),
                            detail,
                        },
                    );
                }
                let automation_notification = crate::automations::complete_run_for_session(
                    &session_id,
                    stop_reason != "rate_limit" && stop_reason != "error",
                    (stop_reason == "rate_limit" || stop_reason == "error")
                        .then_some(stop_reason.as_str()),
                );
                let _ = crate::notifications::append(
                    if stop_reason == "rate_limit" || stop_reason == "error" {
                        crate::notifications::NotificationKind::Error
                    } else {
                        crate::notifications::NotificationKind::SessionComplete
                    },
                    if stop_reason == "rate_limit" || stop_reason == "error" {
                        "会话执行失败"
                    } else {
                        "会话完成"
                    },
                    Some(&stop_reason),
                    Some(&session_id),
                    if stop_reason == "rate_limit" || stop_reason == "error" {
                        "error"
                    } else {
                        "info"
                    },
                );
                if automation_notification
                    .as_ref()
                    .is_none_or(|completion| completion.push)
                {
                    let notify_app = app.clone();
                    let notify_session = session_id.clone();
                    let notify_reason = stop_reason.clone();
                    let automation_name =
                        automation_notification.map(|completion| completion.automation_name);
                    tokio::spawn(async move {
                        let failed = notify_reason == "rate_limit" || notify_reason == "error";
                        let is_automation = automation_name.is_some();
                        let message = crate::notifications::NotifyMessage {
                            title: if let Some(name) = &automation_name {
                                if failed {
                                    format!("自动化失败：{name}")
                                } else {
                                    format!("自动化完成：{name}")
                                }
                            } else if failed {
                                "EchoAgent 会话失败".into()
                            } else {
                                "EchoAgent 会话完成".into()
                            },
                            body: Some(format!(
                                "会话 {}（{}）",
                                &notify_session[..notify_session.len().min(8)],
                                notify_reason
                            )),
                            level: if failed {
                                "error".into()
                            } else {
                                "info".into()
                            },
                            session_id: Some(notify_session),
                        };
                        if is_automation {
                            let _ = crate::notifications::dispatch_automation(&notify_app, message)
                                .await;
                        } else {
                            let _ =
                                crate::notifications::dispatch_external(&notify_app, message, None)
                                    .await;
                        }
                    });
                }
                let _ = app.emit(
                    "agent://complete",
                    CompleteEvent {
                        session_id,
                        stop_reason,
                    },
                );
            } else if method == "echo.agent/session_notification" {
                // Session-scoped notification: EchoAgent uses this to push
                // `SessionSummaryGenerated` after the first user prompt (the
                // LLM-generated title). The update is a tagged enum with the
                // wire field name `sessionUpdate` (see notification.rs:359).
                tracing::info!(
                    method,
                    "received ext notification, dispatching to handle_session_notification"
                );
                handle_session_notification(app, &params);
            } else if method == "echo.agent/mcp/server_status"
                || method == "echo.agent/mcp/init_progress"
            {
                // MCP connector status / startup progress — surface to the
                // connectors panel for live state updates.
                let _ = app.emit("agent://mcp-status", &params);
            } else if method == "echo.agent/toggle_plan_mode" {
                // Plan mode toggled (either by us or by EchoAgent). Mirror to frontend.
                let _ = app.emit("agent://plan-mode", &params);
            } else if method == "echo.agent/yolo_mode_changed" {
                // Permission mode (auto/yolo) changed.
                let _ = app.emit("agent://permission-mode", &params);
            } else if method == "echo.agent/models/update" {
                // Model list updated (e.g. after config reload).
                let _ = app.emit("agent://models-update", &params);
            } else if method == "echo.agent/task_backgrounded"
                || method == "echo.agent/task_completed"
            {
                // Background task lifecycle — refresh the tasks panel.
                let _ = app.emit("agent://task-update", &params);
            } else if method == "echo.agent/git_head_changed"
                || method == "echo.agent/gitHeadChanged"
            {
                // git HEAD moved — useful for status bar / worktree UI.
                let _ = app.emit("agent://git-head", &params);
            }
            let _ = b.response_tx.send(Ok(()));
        }
        AcpClientMessage::ReadTextFile(b) => deny_fs_terminal(b.response_tx),
        AcpClientMessage::WriteTextFile(b) => deny_fs_terminal(b.response_tx),
        AcpClientMessage::CreateTerminal(b) => deny_fs_terminal(b.response_tx),
        AcpClientMessage::TerminalOutput(b) => deny_fs_terminal(b.response_tx),
        AcpClientMessage::ReleaseTerminal(b) => deny_fs_terminal(b.response_tx),
        AcpClientMessage::WaitForTerminalExit(b) => deny_fs_terminal(b.response_tx),
        AcpClientMessage::KillTerminalCommand(b) => deny_fs_terminal(b.response_tx),
        AcpClientMessage::ExtMethod(b) => {
            let method = b.request.method.as_ref().to_string();
            let raw_str = b.request.params.get();
            match method.as_str() {
                "echo.agent/ask_user_question" => {
                    if raw_str.len() > MAX_EXT_METHOD_PARAMS_BYTES {
                        tracing::warn!(
                            "oversized ask_user_question request; cancelling fail-closed"
                        );
                        send_ext_json(b.response_tx, serde_json::json!({ "outcome": "cancelled" }));
                        return;
                    };
                    let request = match serde_json::from_str::<QuestionWireRequest>(raw_str) {
                        Ok(request) => request,
                        Err(error) => {
                            tracing::warn!(%error, "malformed ask_user_question request; cancelling fail-closed");
                            send_ext_json(
                                b.response_tx,
                                serde_json::json!({ "outcome": "cancelled" }),
                            );
                            return;
                        }
                    };
                    let frontend = match question_frontend_from_wire(request) {
                        Ok(frontend) => frontend,
                        Err(error) => {
                            tracing::warn!(%error, "invalid ask_user_question request; cancelling fail-closed");
                            send_ext_json(
                                b.response_tx,
                                serde_json::json!({ "outcome": "cancelled" }),
                            );
                            return;
                        }
                    };
                    let request_id = frontend.request_id.clone();
                    let session_id = frontend.session_id.clone();
                    let rx = match questions.register(frontend.clone()).await {
                        Ok(rx) => rx,
                        Err(error) => {
                            tracing::warn!(%error, "question queue full; cancelling fail-closed");
                            send_ext_json(
                                b.response_tx,
                                serde_json::json!({ "outcome": "cancelled" }),
                            );
                            return;
                        }
                    };
                    tracing::info!(request_id, "emitting agent://question");
                    if app.emit("agent://question", frontend).is_err() {
                        let _ = questions
                            .resolve(&request_id, QuestionOutcome::Cancelled)
                            .await;
                    }

                    let registry = questions.clone();
                    let response_app = app.clone();
                    let mut response_tx = b.response_tx;
                    tokio::spawn(async move {
                        let outcome = tokio::select! {
                            result = rx => result.unwrap_or(QuestionOutcome::Cancelled),
                            () = response_tx.closed() => {
                                registry.discard(&request_id).await;
                                emit_question_closed(&response_app, &session_id, &request_id);
                                return;
                            }
                        };
                        let value = question_response_value(outcome);
                        send_ext_json(response_tx, value);
                        emit_question_closed(&response_app, &session_id, &request_id);
                    });
                }
                "echo.agent/exit_plan_mode" => {
                    if raw_str.len() > MAX_EXT_METHOD_PARAMS_BYTES {
                        tracing::warn!("oversized exit_plan_mode request; cancelling fail-closed");
                        send_ext_json(b.response_tx, serde_json::json!({ "outcome": "cancelled" }));
                        return;
                    };
                    let request = match serde_json::from_str::<PlanApprovalWireRequest>(raw_str) {
                        Ok(request) => request,
                        Err(error) => {
                            tracing::warn!(%error, "malformed exit_plan_mode request; cancelling fail-closed");
                            send_ext_json(
                                b.response_tx,
                                serde_json::json!({ "outcome": "cancelled" }),
                            );
                            return;
                        }
                    };
                    let frontend = match plan_frontend_from_wire(request) {
                        Ok(frontend) => frontend,
                        Err(error) => {
                            tracing::warn!(%error, "invalid exit_plan_mode request; cancelling fail-closed");
                            send_ext_json(
                                b.response_tx,
                                serde_json::json!({ "outcome": "cancelled" }),
                            );
                            return;
                        }
                    };
                    let request_id = frontend.request_id.clone();
                    let session_id = frontend.session_id.clone();
                    let rx = match plan_approvals.register(frontend.clone()).await {
                        Ok(rx) => rx,
                        Err(error) => {
                            tracing::warn!(%error, "plan approval queue full; cancelling fail-closed");
                            send_ext_json(
                                b.response_tx,
                                serde_json::json!({ "outcome": "cancelled" }),
                            );
                            return;
                        }
                    };
                    emit_plan_approval(app, "plan_approval_request", &frontend);
                    if app.emit("agent://plan-approval", frontend).is_err() {
                        let _ = plan_approvals
                            .resolve(
                                &request_id,
                                PlanApprovalOutcome::Cancelled { feedback: None },
                            )
                            .await;
                    }

                    let registry = plan_approvals.clone();
                    let response_app = app.clone();
                    let mut response_tx = b.response_tx;
                    tokio::spawn(async move {
                        let outcome = tokio::select! {
                            result = rx => result.unwrap_or(PlanApprovalOutcome::Cancelled { feedback: None }),
                            () = response_tx.closed() => {
                                registry.discard(&request_id).await;
                                emit_plan_approval_closed(&response_app, &session_id, &request_id);
                                return;
                            }
                        };
                        let value = match outcome {
                            PlanApprovalOutcome::Approved => {
                                serde_json::json!({ "outcome": "approved" })
                            }
                            PlanApprovalOutcome::Cancelled { feedback } => {
                                serde_json::json!({ "outcome": "cancelled", "feedback": feedback })
                            }
                            PlanApprovalOutcome::Abandoned => {
                                serde_json::json!({ "outcome": "abandoned" })
                            }
                        };
                        send_ext_json(response_tx, value);
                        emit_plan_approval_closed(&response_app, &session_id, &request_id);
                    });
                }
                "echo.agent/folder_trust/request" => {
                    if raw_str.len() > MAX_EXT_METHOD_PARAMS_BYTES {
                        tracing::warn!("oversized folder trust request; rejecting fail-closed");
                        send_ext_json(b.response_tx, serde_json::json!({ "outcome": "reject" }));
                        return;
                    };
                    let request = match serde_json::from_str::<FolderTrustWireRequest>(raw_str) {
                        Ok(request) => request,
                        Err(error) => {
                            tracing::warn!(%error, "malformed folder trust request; rejecting fail-closed");
                            send_ext_json(
                                b.response_tx,
                                serde_json::json!({ "outcome": "reject" }),
                            );
                            return;
                        }
                    };
                    let frontend = match folder_trust_frontend_from_wire(request) {
                        Ok(frontend) => frontend,
                        Err(error) => {
                            tracing::warn!(%error, "invalid folder trust request; rejecting fail-closed");
                            send_ext_json(
                                b.response_tx,
                                serde_json::json!({ "outcome": "reject" }),
                            );
                            return;
                        }
                    };
                    let request_id = frontend.request_id.clone();
                    let rx = match folder_trusts.register(frontend.clone()).await {
                        Ok(rx) => rx,
                        Err(error) => {
                            tracing::warn!(%error, "folder trust queue full; rejecting fail-closed");
                            send_ext_json(
                                b.response_tx,
                                serde_json::json!({ "outcome": "reject" }),
                            );
                            return;
                        }
                    };
                    tracing::info!(request_id, "emitting agent://folder-trust");
                    if app.emit("agent://folder-trust", frontend).is_err() {
                        let _ = folder_trusts
                            .resolve(&request_id, FolderTrustOutcome::Reject)
                            .await;
                    }

                    let registry = folder_trusts.clone();
                    let mut response_tx = b.response_tx;
                    tokio::spawn(async move {
                        let outcome = tokio::select! {
                            result = rx => result.unwrap_or(FolderTrustOutcome::Reject),
                            () = response_tx.closed() => {
                                registry.discard(&request_id).await;
                                return;
                            }
                        };
                        let value = match outcome {
                            FolderTrustOutcome::Trust => serde_json::json!({ "outcome": "trust" }),
                            FolderTrustOutcome::Reject => {
                                serde_json::json!({ "outcome": "reject" })
                            }
                        };
                        send_ext_json(response_tx, value);
                    });
                }
                _ => {
                    let err = acp::Error::new(
                        acp::ErrorCode::MethodNotFound.into(),
                        format!("ext method unsupported: {method}"),
                    );
                    let _ = b.response_tx.send(Err(err));
                }
            }
        }
    }
}

fn send_ext_json(response_tx: oneshot::Sender<acp::Result<acp::ExtResponse>>, value: Value) {
    let raw = serde_json::value::to_raw_value(&value)
        .unwrap_or_else(|_| serde_json::value::to_raw_value(&Value::Null).expect("null JSON"));
    let _ = response_tx.send(Ok(acp::ExtResponse::new(raw.into())));
}

fn send_permission_cancelled(
    response_tx: tokio::sync::oneshot::Sender<acp::Result<acp::RequestPermissionResponse>>,
) {
    let response = acp::RequestPermissionResponse::new(acp::RequestPermissionOutcome::Cancelled);
    let _ = response_tx.send(Ok(response));
}

fn question_response_value(outcome: QuestionOutcome) -> Value {
    match outcome {
        QuestionOutcome::Accepted {
            answers,
            annotations,
        } => {
            let mut value = serde_json::json!({
                "outcome": "accepted",
                "answers": answers,
            });
            if let Some(annotations) = annotations.filter(|items| !items.is_empty()) {
                value
                    .as_object_mut()
                    .expect("question response is an object")
                    .insert(
                        "annotations".into(),
                        serde_json::to_value(annotations).unwrap_or(Value::Null),
                    );
            }
            value
        }
        QuestionOutcome::ChatAboutThis { partial_answers } => serde_json::json!({
            "outcome": "chat_about_this",
            "partial_answers": partial_answers,
        }),
        QuestionOutcome::SkipInterview { partial_answers } => serde_json::json!({
            "outcome": "skip_interview",
            "partial_answers": partial_answers,
        }),
        QuestionOutcome::Cancelled => serde_json::json!({ "outcome": "cancelled" }),
    }
}

fn emit_question_closed(app: &AppHandle, session_id: &str, request_id: &str) {
    let _ = app.emit(
        "agent://question-closed",
        QuestionClosedFrontend {
            request_id: request_id.to_string(),
            session_id: session_id.to_string(),
        },
    );
}

fn emit_plan_approval(app: &AppHandle, update_kind: &str, request: &PlanApprovalFrontend) {
    let mut update = serde_json::to_value(request).unwrap_or(Value::Null);
    if let Some(object) = update.as_object_mut() {
        object.insert(
            "sessionUpdate".into(),
            Value::String(update_kind.to_string()),
        );
    }
    let _ = app.emit(
        "agent://update",
        UpdateEvent {
            session_id: Some(request.session_id.clone()),
            update,
        },
    );
}

fn emit_plan_approval_closed(app: &AppHandle, session_id: &str, request_id: &str) {
    let _ = app.emit(
        "agent://update",
        UpdateEvent {
            session_id: Some(session_id.to_string()),
            update: serde_json::json!({
                "sessionUpdate": "plan_approval_resolved",
                "requestId": request_id,
            }),
        },
    );
}

/// Parse an `echo.agent/session_notification` payload and, if it carries a freshly
/// generated session title (`SessionSummaryGenerated`), emit `agent://summary`
/// so the frontend can update the sidebar entry. Unknown update variants are
/// ignored (we ACK regardless, in `handle_client_message`).
///
/// The wire shape (snake_case tag AND fields — EchoAgent's `SessionUpdate` uses
/// `rename_all = "snake_case"` on the enum, which renames only the tag; the
/// struct-variant fields keep their Rust snake_case names):
/// ```json
/// { "sessionId": "...", "update": { "sessionUpdate": "session_summary_generated",
///                                   "session_summary": "..." }, "meta": {...} }
/// ```
fn handle_session_notification(app: &AppHandle, params: &Value) {
    let Some(session_id) = params.get("sessionId").and_then(|v| v.as_str()) else {
        tracing::debug!("session_notification: missing sessionId, ignoring");
        return;
    };
    let Some(update) = params.get("update") else {
        tracing::debug!(session_id, "session_notification: missing update field");
        return;
    };
    let kind = update
        .get("sessionUpdate")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    tracing::info!(session_id, kind, "received echo.agent/session_notification");
    match kind {
        "turn_completed" => {
            if let Some(event) = parse_turn_usage_event(session_id, params, update) {
                let _ = app.emit("agent://turn-usage", event);
            }
        }
        "session_summary_generated" => {
            // Accept the camelCase variant too, defensively — reading only
            // `sessionSummary` silently drops every generated title (the event
            // never fires and the sidebar/topbar keeps the placeholder).
            let raw_title = update
                .get("session_summary")
                .or_else(|| update.get("sessionSummary"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let is_manual = params
                .get("_meta")
                .and_then(|meta| meta.get("echo.agent/titleIsManual"))
                .and_then(Value::as_bool)
                == Some(true);
            let title = if is_manual {
                (!raw_title.trim().is_empty()).then(|| raw_title.trim().to_string())
            } else {
                crate::session_title::clean_auto_title(raw_title)
            };
            if let Some(title) = title {
                tracing::info!(session_id, title, "emitting agent://summary");
                let _ = app.emit(
                    "agent://summary",
                    SummaryEvent {
                        session_id: session_id.to_string(),
                        title,
                    },
                );
            } else {
                tracing::warn!(
                    session_id,
                    "session_summary_generated contained no safe display title"
                );
            }
        }
        "subagent_spawned" | "subagent_progress" | "subagent_finished" => {
            emit_subagent_event(app, session_id, kind, update);
        }
        _ => {
            tracing::debug!(
                session_id,
                kind,
                "session_notification: unhandled kind, ignoring"
            );
        }
    }
}

fn parse_turn_usage_event(
    session_id: &str,
    params: &Value,
    update: &Value,
) -> Option<TurnUsageEvent> {
    let prompt_id = update
        .get("prompt_id")
        .or_else(|| update.get("promptId"))
        .and_then(Value::as_str)?;
    if prompt_id.is_empty() {
        return None;
    }
    let usage = update.get("usage").filter(|value| value.is_object())?;
    let meta = params.get("_meta");
    Some(TurnUsageEvent {
        session_id: session_id.to_string(),
        prompt_id: prompt_id.to_string(),
        usage: usage.clone(),
        occurred_at: meta
            .and_then(|value| value.get("agentTimestampMs"))
            .and_then(Value::as_i64),
        event_id: meta
            .and_then(|value| value.get("eventId"))
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

/// Forward subagent lifecycle events to the frontend as `agent://subagent`.
/// EchoAgent emits `subagent_spawned` (before child starts), `subagent_progress`
/// (every ~2s while running), and `subagent_finished` (on completion).
fn emit_subagent_event(app: &AppHandle, parent_session_id: &str, kind: &str, update: &Value) {
    let subagent_id = update
        .get("subagent_id")
        .or_else(|| update.get("subagentId"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if subagent_id.is_empty() {
        tracing::warn!(kind, "subagent notification missing subagent_id, skipping");
        return;
    }

    let str_field = |key: &str| {
        update
            .get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    };
    let u64_field = |key: &str| {
        update
            .get(key)
            .and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|f| f as u64)))
    };
    let u32_field = |key: &str| u64_field(key).map(|v| v as u32);
    let u8_field = |key: &str| u64_field(key).map(|v| v as u8);

    let (phase, status) = match kind {
        "subagent_spawned" => ("spawned".to_string(), Some("running".to_string())),
        "subagent_progress" => ("progress".to_string(), Some("running".to_string())),
        "subagent_finished" => {
            let st = str_field("status").unwrap_or_else(|| "completed".to_string());
            ("finished".to_string(), Some(st))
        }
        _ => return,
    };

    let tools_used = update
        .get("tools_used")
        .or_else(|| update.get("toolsUsed"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| t.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>()
        });

    let evt = SubagentEvent {
        session_id: parent_session_id.to_string(),
        phase,
        subagent_id: subagent_id.clone(),
        child_session_id: str_field("child_session_id")
            .or_else(|| str_field("childSessionId"))
            .or_else(|| Some(subagent_id.clone())),
        description: str_field("description"),
        subagent_type: str_field("subagent_type").or_else(|| str_field("subagentType")),
        status,
        duration_ms: u64_field("duration_ms").or_else(|| u64_field("durationMs")),
        turn_count: u32_field("turn_count")
            .or_else(|| u32_field("turnCount"))
            .or_else(|| u32_field("turns")),
        tool_call_count: u32_field("tool_call_count")
            .or_else(|| u32_field("toolCallCount"))
            .or_else(|| u32_field("tool_calls")),
        tokens_used: u64_field("tokens_used").or_else(|| u64_field("tokensUsed")),
        context_window_tokens: u64_field("context_window_tokens")
            .or_else(|| u64_field("contextWindowTokens")),
        context_usage_pct: u8_field("context_usage_pct").or_else(|| u8_field("contextUsagePct")),
        tools_used,
        error: str_field("error"),
        output: str_field("output"),
    };

    tracing::info!(
        session_id = %evt.session_id,
        phase = %evt.phase,
        subagent_id = %evt.subagent_id,
        "emitting agent://subagent"
    );
    let _ = app.emit("agent://subagent", evt);
}

/// Send a MethodNotFound error on a fs/terminal response channel. We advertised
/// no fs/terminal capability so these shouldn't arrive — deny to keep the
/// agent's future from hanging.
fn deny_fs_terminal<T>(response_tx: tokio::sync::oneshot::Sender<acp::Result<T>>) {
    let err = acp::Error::new(
        acp::ErrorCode::MethodNotFound.into(),
        "EchoAgent does not handle fs/terminal requests".to_string(),
    );
    let _ = response_tx.send(Err(err));
}

/// `acp::SessionUpdate` isn't `Serialize` in a form we can emit directly, so
/// round-trip through JSON: the ACP crate does serialize for the wire format.
fn serialize_session_update(update: &acp::SessionUpdate) -> Value {
    serde_json::to_value(update).unwrap_or_else(
        |_| serde_json::json!({ "type": "unknown", "error": "failed to serialize session update" }),
    )
}

fn permission_kind_str(k: &acp::PermissionOptionKind) -> &'static str {
    match k {
        acp::PermissionOptionKind::AllowOnce => "allow",
        acp::PermissionOptionKind::AllowAlways => "allow_always",
        acp::PermissionOptionKind::RejectOnce => "deny",
        acp::PermissionOptionKind::RejectAlways => "deny_always",
        _ => "other",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn question_wire_preserves_mode_multiselect_description_and_preview() {
        let request: QuestionWireRequest = serde_json::from_value(serde_json::json!({
            "sessionId": "s-1",
            "toolCallId": "tc-1",
            "mode": "plan",
            "timeoutSecs": 42,
            "questions": [{
                "id": "database",
                "question": "Which database?",
                "multiSelect": true,
                "options": [{
                    "id": "redis",
                    "label": "Redis",
                    "description": "In-memory store",
                    "preview": "redis.conf"
                }]
            }]
        }))
        .expect("typed question request");
        assert_eq!(request.mode, QuestionMode::Plan);
        assert_eq!(request.timeout, Some(42));
        assert_eq!(request.questions[0].multi_select, Some(true));
        let QuestionWireOption::Detailed {
            description,
            preview,
            ..
        } = &request.questions[0].options[0]
        else {
            panic!("expected detailed option")
        };
        assert_eq!(description, "In-memory store");
        assert_eq!(preview.as_deref(), Some("redis.conf"));
    }

    #[test]
    fn question_frontend_limits_runtime_wire_fields() {
        let request: QuestionWireRequest = serde_json::from_value(serde_json::json!({
            "sessionId": "s-1",
            "toolCallId": "tc-1",
            "title": "Pick a database",
            "timeoutSecs": u64::MAX,
            "questions": [{
                "question": "Which database?",
                "options": [{
                    "id": "redis",
                    "label": "Redis",
                    "description": "x".repeat(MAX_INTERACTION_TITLE_CHARS + 10),
                    "preview": "redis.conf"
                }]
            }]
        }))
        .expect("typed question request");
        let frontend = question_frontend_from_wire(request).expect("bounded frontend request");
        assert_eq!(frontend.timeout, Some(MAX_QUESTION_TIMEOUT_SECS));
        assert!(frontend.questions[0].options[0]
            .description
            .ends_with("[truncated]"));

        let oversized_questions: Vec<Value> = (0..=MAX_QUESTION_ITEMS)
            .map(|index| {
                serde_json::json!({
                    "question": format!("Question {index}?"),
                    "options": []
                })
            })
            .collect();
        let request: QuestionWireRequest = serde_json::from_value(serde_json::json!({
            "sessionId": "s-1",
            "toolCallId": "tc-1",
            "questions": oversized_questions
        }))
        .expect("typed oversized question request");
        assert!(question_frontend_from_wire(request).is_err());
    }

    #[test]
    fn permission_raw_input_is_bounded_for_frontend() {
        let raw = serde_json::json!({
            "payload": "x".repeat(MAX_PERMISSION_RAW_INPUT_BYTES + 1)
        });
        let bounded = capped_json_for_frontend(Some(&raw)).expect("bounded value");
        assert_eq!(bounded["_truncated"], true);
    }

    #[test]
    fn plan_question_actions_use_runtime_wire_outcomes() {
        let chat = question_response_value(QuestionOutcome::ChatAboutThis {
            partial_answers: HashMap::from([("Database?".into(), "Redis".into())]),
        });
        assert_eq!(chat["outcome"], "chat_about_this");
        assert_eq!(chat["partial_answers"]["Database?"], "Redis");

        let skip = question_response_value(QuestionOutcome::SkipInterview {
            partial_answers: HashMap::new(),
        });
        assert_eq!(skip["outcome"], "skip_interview");
    }

    #[tokio::test]
    async fn plan_registry_is_ordered_replayable_and_acked_once() {
        let registry = PlanApprovals::new();
        let first = PlanApprovalFrontend {
            request_id: "r-1".into(),
            session_id: "s-1".into(),
            tool_call_id: "tc-1".into(),
            plan_content: Some("first".into()),
        };
        let second = PlanApprovalFrontend {
            request_id: "r-2".into(),
            session_id: "s-1".into(),
            tool_call_id: "tc-2".into(),
            plan_content: Some("second".into()),
        };
        let first_rx = registry.register(first).await.expect("first request");
        let _second_rx = registry.register(second).await.expect("second request");
        let ids: Vec<String> = registry
            .list(Some("s-1"))
            .await
            .into_iter()
            .map(|request| request.request_id)
            .collect();
        assert_eq!(ids, ["r-1", "r-2"]);
        assert!(registry.resolve("r-1", PlanApprovalOutcome::Approved).await);
        assert!(
            !registry
                .resolve("r-1", PlanApprovalOutcome::Abandoned)
                .await
        );
        assert!(matches!(
            first_rx.await.expect("approval result"),
            PlanApprovalOutcome::Approved
        ));
    }

    #[tokio::test]
    async fn plan_registry_rejects_when_pending_queue_is_full() {
        let registry = PlanApprovals::new();
        for index in 0..MAX_PENDING_INTERACTIONS {
            registry
                .register(PlanApprovalFrontend {
                    request_id: format!("r-{index}"),
                    session_id: "s-1".into(),
                    tool_call_id: format!("tc-{index}"),
                    plan_content: None,
                })
                .await
                .expect("queue slot");
        }
        assert!(registry
            .register(PlanApprovalFrontend {
                request_id: "overflow".into(),
                session_id: "s-1".into(),
                tool_call_id: "tc-overflow".into(),
                plan_content: None,
            })
            .await
            .is_err());
    }

    #[test]
    fn parses_durable_turn_usage_with_replay_metadata() {
        let params = serde_json::json!({
            "_meta": { "eventId": "evt-1", "agentTimestampMs": 1_788_000_000_000_i64 }
        });
        let update = serde_json::json!({
            "sessionUpdate": "turn_completed",
            "prompt_id": "p-1",
            "usage": { "inputTokens": 120, "outputTokens": 30, "modelCalls": 2 }
        });
        let event = parse_turn_usage_event("s-1", &params, &update).expect("valid usage");
        assert_eq!(event.session_id, "s-1");
        assert_eq!(event.prompt_id, "p-1");
        assert_eq!(event.occurred_at, Some(1_788_000_000_000));
        assert_eq!(event.event_id.as_deref(), Some("evt-1"));
        assert_eq!(event.usage["modelCalls"], 2);
    }

    #[test]
    fn rejects_turn_usage_without_prompt_or_ledger() {
        assert!(parse_turn_usage_event(
            "s",
            &Value::Null,
            &serde_json::json!({
                "usage": { "inputTokens": 1 }
            })
        )
        .is_none());
        assert!(parse_turn_usage_event(
            "s",
            &Value::Null,
            &serde_json::json!({
                "prompt_id": "p"
            })
        )
        .is_none());
    }
}
