//! Default-permission rules — reads/writes EchoAgent's `[permission]` config block.
//!
//! EchoAgent evaluates tool-call permission against rules in `~/.echo-agent/config.toml`:
//!
//! ```toml
//! [permission]
//! deny = ["Bash(rm -rf *)"]
//! allow = ["Bash(git *)", "Bash(gh *)"]
//! # OR structured form:
//! rules = [
//!   { action = "allow", tool = "bash", pattern = "git *" },
//!   { action = "deny",  tool = "bash", pattern = "rm -rf *" },
//! ]
//! ```
//!
//! We read BOTH forms and expose a unified `Vec<PermissionRule>`; writes always
//! go to the compact string-array form (`deny = [...]` / `allow = [...]`) so
//! we don't fight EchoAgent's own structured editor. Reuses `providers.rs`'s
//! atomic `read_config`/`write_config` pattern. NOTE: changes require a EchoAgent
//! restart to take effect (EchoAgent loads config once at agent init).

use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, State};
use toml::map::Map;
use toml::Value;

use crate::bridge::{emit_permission_closed, Permissions};
use crate::commands::AppState;

/// One permission rule. `action` is one of "allow" | "deny" | "ask";
/// `tool` is "bash" | "read" | "edit" | "grep" | "mcp" | "webfetch" | "any";
/// `pattern` is an optional glob (e.g. "git *").
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRule {
    pub action: String,
    pub tool: String,
    #[serde(default)]
    pub pattern: Option<String>,
}

/// EchoAgent stores compact-form rules as `Tool(pattern)` strings. Parse one into
/// our structured form. Examples: `"Bash(git *)"`, `"Read"`, `"Edit(/tmp/**)"`.
fn parse_compact_rule(s: &str, action: &str) -> PermissionRule {
    let s = s.trim();
    if let Some(open) = s.find('(') {
        let tool = s[..open].trim().to_lowercase();
        // `Bash(git *)` → pattern = "git *". Strip trailing ')'.
        let pattern = s[open + 1..].trim_end_matches(')').trim().to_string();
        PermissionRule {
            action: action.to_string(),
            tool,
            pattern: if pattern.is_empty() {
                None
            } else {
                Some(pattern)
            },
        }
    } else {
        PermissionRule {
            action: action.to_string(),
            tool: s.to_lowercase(),
            pattern: None,
        }
    }
}

/// Read the `[permission]` block from config.toml. Supports both the compact
/// (`deny = [...]`) and structured (`rules = [{ action, tool, pattern }]`)
/// forms. Returns an empty vec if config is missing or the block is absent.
pub fn read_rules() -> Vec<PermissionRule> {
    let config = crate::providers::read_config();
    let Some(perm) = config.get("permission").and_then(Value::as_table) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    // Compact form: deny/allow/ask are arrays of "Tool(pattern)" strings.
    for action in &["deny", "allow", "ask"] {
        if let Some(arr) = perm.get(*action).and_then(Value::as_array) {
            for v in arr {
                if let Some(s) = v.as_str() {
                    out.push(parse_compact_rule(s, action));
                }
            }
        }
    }
    // Structured form: `rules = [{ action, tool, pattern }]`.
    if let Some(arr) = perm.get("rules").and_then(Value::as_array) {
        for v in arr {
            let Some(table) = v.as_table() else { continue };
            out.push(PermissionRule {
                action: table
                    .get("action")
                    .and_then(Value::as_str)
                    .unwrap_or("allow")
                    .to_string(),
                tool: table
                    .get("tool")
                    .and_then(Value::as_str)
                    .unwrap_or("any")
                    .to_string(),
                pattern: table
                    .get("pattern")
                    .and_then(Value::as_str)
                    .map(String::from),
            });
        }
    }
    out
}

/// Render a rule back to EchoAgent's compact `Tool(pattern)` form.
fn rule_to_compact(rule: &PermissionRule) -> String {
    let tool = rule.tool.to_lowercase();
    let cap = capitalize_tool(&tool);
    match &rule.pattern {
        Some(p) if !p.is_empty() => format!("{cap}({p})"),
        _ => cap,
    }
}

fn capitalize_tool(tool: &str) -> String {
    let mut c = tool.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// Replace the `[permission]` block's compact-form arrays. We always write the
/// compact form (deny/allow/ask) and drop any structured `rules` array to
/// avoid ambiguity — EchoAgent accepts both, but mixing them is confusing.
pub fn write_rules(rules: Vec<PermissionRule>) -> Result<(), String> {
    for rule in &rules {
        if !["allow", "deny", "ask"].contains(&rule.action.as_str()) {
            return Err(format!("invalid permission action: {}", rule.action));
        }
        if !["bash", "read", "edit", "grep", "mcp", "webfetch", "any"].contains(&rule.tool.as_str())
        {
            return Err(format!("invalid permission tool: {}", rule.tool));
        }
        if rule
            .pattern
            .as_deref()
            .is_some_and(|p| p.contains(['\n', '\r']))
        {
            return Err("permission pattern must be a single line".into());
        }
    }
    crate::providers::update_config(|config| {
        let table = config.as_table_mut().ok_or("config root is not a table")?;
        // Reset the [permission] block: drop it entirely so we rewrite from scratch.
        table.remove("permission");
        if rules.is_empty() {
            return Ok(());
        }
        let mut perm = Map::new();
        // Group by action.
        let mut deny: Vec<Value> = Vec::new();
        let mut allow: Vec<Value> = Vec::new();
        let mut ask: Vec<Value> = Vec::new();
        for rule in &rules {
            let compact = rule_to_compact(rule);
            let v = Value::String(compact);
            match rule.action.as_str() {
                "deny" => deny.push(v),
                "ask" => ask.push(v),
                _ => allow.push(v),
            }
        }
        if !deny.is_empty() {
            perm.insert("deny".into(), Value::Array(deny));
        }
        if !allow.is_empty() {
            perm.insert("allow".into(), Value::Array(allow));
        }
        if !ask.is_empty() {
            perm.insert("ask".into(), Value::Array(ask));
        }
        table.insert("permission".into(), Value::Table(perm));
        Ok(())
    })
}

/// List the current permission rules. Read-only — no agent round-trip needed.
#[tauri::command]
pub fn permission_list(_state: State<'_, AppState>) -> Vec<PermissionRule> {
    read_rules()
}

/// Replace all permission rules with the supplied list. Atomic write to
/// config.toml; requires a EchoAgent restart to take effect.
#[tauri::command]
pub fn permission_save(
    _state: State<'_, AppState>,
    rules: Vec<PermissionRule>,
) -> Result<(), String> {
    write_rules(rules)
}

// ========================================================================
// Agent / assistant defaults — `[models] default` + `[ui] default_selected_permission`
// ========================================================================

/// The current "new session" defaults that affect every agent/assistant.
/// Mirrors EchoAgent's `[models] default` and `[ui] default_selected_permission`
/// config keys (see user-guide/05-configuration.md).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefaults {
    /// Model id used for new sessions (`[models] default`). Empty = EchoAgent
    /// falls back to its built-in default (`echo-agent-build`).
    #[serde(default)]
    pub default_model: String,
    /// Default permission selection on the FIRST approval prompt
    /// (`[ui] default_selected_permission`). One of:
    /// "always_allow_all_sessions" | "always_allow_this_session" |
    /// "allow_once" | "always_deny_all_sessions" | "deny_once".
    /// Empty = EchoAgent's built-in default (no preselection).
    #[serde(default)]
    pub default_permission: String,
    /// Whether to show "Always allow" options on permission prompts
    /// (`[ui] remember_tool_approvals`). Null = unset.
    #[serde(default)]
    pub remember_tool_approvals: Option<bool>,
}

/// Read the agent defaults from config.toml.
pub fn read_defaults() -> AgentDefaults {
    let config = crate::providers::read_config();
    let mut out = AgentDefaults::default();
    if let Some(models) = config.get("models").and_then(Value::as_table) {
        if let Some(d) = models.get("default").and_then(Value::as_str) {
            out.default_model = d.to_string();
        }
    }
    if let Some(ui) = config.get("ui").and_then(Value::as_table) {
        if let Some(p) = ui
            .get("default_selected_permission")
            .and_then(Value::as_str)
        {
            out.default_permission = p.to_string();
        }
        if let Some(r) = ui.get("remember_tool_approvals").and_then(Value::as_bool) {
            out.remember_tool_approvals = Some(r);
        }
    }
    out
}

/// Write the agent defaults to config.toml. We preserve all other keys in
/// `[models]` and `[ui]` (merge, not replace).
pub fn write_defaults(defaults: &AgentDefaults) -> Result<(), String> {
    crate::providers::update_config(|config| {
        let root = config.as_table_mut().ok_or("config root is not a table")?;

        // [models].default
        if !root.contains_key("models") {
            root.insert("models".into(), Value::Table(Map::new()));
        }
        if let Some(models) = root.get_mut("models").and_then(Value::as_table_mut) {
            if defaults.default_model.is_empty() {
                models.remove("default");
            } else {
                models.insert(
                    "default".into(),
                    Value::String(defaults.default_model.clone()),
                );
            }
        }

        // [ui].default_selected_permission + remember_tool_approvals
        if !root.contains_key("ui") {
            root.insert("ui".into(), Value::Table(Map::new()));
        }
        if let Some(ui) = root.get_mut("ui").and_then(Value::as_table_mut) {
            if defaults.default_permission.is_empty() {
                ui.remove("default_selected_permission");
            } else {
                ui.insert(
                    "default_selected_permission".into(),
                    Value::String(defaults.default_permission.clone()),
                );
            }
            match defaults.remember_tool_approvals {
                Some(b) => {
                    ui.insert("remember_tool_approvals".into(), Value::Boolean(b));
                }
                None => {
                    ui.remove("remember_tool_approvals");
                }
            }
        }

        Ok(())
    })
}

/// Read the agent defaults (new-session model + default permission).
#[tauri::command]
pub fn agents_defaults_get(_state: State<'_, AppState>) -> AgentDefaults {
    read_defaults()
}

/// Save the agent defaults. Atomic write to config.toml.
#[tauri::command]
pub fn agents_defaults_save(
    _state: State<'_, AppState>,
    defaults: AgentDefaults,
) -> Result<(), String> {
    write_defaults(&defaults)
}

// ========================================================================
// Permission mode — `[ui] permission_mode` ("ask" | "auto" | "always-approve")
// ========================================================================

/// Canonical permission modes EchoAgent accepts (see echo-agent-build
/// `util/config/permissions.rs::parse_permission_mode_canonical`).
pub const PERMISSION_MODES: [&str; 3] = ["ask", "auto", "always-approve"];
const AUTO_MODE_UNAVAILABLE_REASON: &str = "自动模式已被本机配置、环境设置或组织策略关闭";
const ALWAYS_APPROVE_UNAVAILABLE_REASON: &str = "始终允许已被本机要求或组织策略禁用";

/// Runtime flags corresponding to the canonical desktop permission mode.
/// Keeping this mapping in one place prevents launch defaults and per-session
/// metadata from drifting apart.
pub(crate) fn permission_mode_flags(mode: &str) -> (bool, bool) {
    (mode == "always-approve", mode == "auto")
}

fn auto_mode_available() -> bool {
    echo_agent_runtime::util::config::auto_permission_mode_enabled_from_disk()
}

fn always_approve_policy_block() -> Option<String> {
    let effective = echo_agent_runtime::util::config::effective_yolo_for_launch(
        false,
        Some("always-approve"),
        None,
    );
    (!effective.yolo).then(|| ALWAYS_APPROVE_UNAVAILABLE_REASON.to_string())
}

pub(crate) fn ensure_always_approve_available() -> Result<(), String> {
    match always_approve_policy_block() {
        Some(reason) => Err(reason),
        None => Ok(()),
    }
}

fn effective_permission_mode(
    configured_mode: &str,
    auto_available: bool,
    always_approve_available: bool,
) -> String {
    match configured_mode {
        "auto" if !auto_available => "ask".into(),
        "always-approve" if !always_approve_available => "ask".into(),
        _ => configured_mode.into(),
    }
}

fn validate_permission_mode_selection(
    mode: &str,
    auto_available: bool,
    always_approve_available: bool,
) -> Result<(), String> {
    if !PERMISSION_MODES.contains(&mode) {
        return Err(format!("unknown permission mode: {mode}"));
    }
    if mode == "auto" && !auto_available {
        return Err(AUTO_MODE_UNAVAILABLE_REASON.into());
    }
    if mode == "always-approve" && !always_approve_available {
        return Err(always_approve_policy_block()
            .unwrap_or_else(|| ALWAYS_APPROVE_UNAVAILABLE_REASON.into()));
    }
    Ok(())
}

/// Read the user's persisted permission preference. Mirrors EchoAgent's precedence:
/// `permission_mode` > legacy `approval_mode` > legacy `yolo`; default "ask".
fn read_user_configured_permission_mode() -> String {
    let config = crate::providers::read_config();
    let Some(ui) = config.get("ui").and_then(Value::as_table) else {
        return "ask".into();
    };
    if let Some(m) = ui.get("permission_mode").and_then(Value::as_str) {
        return match m {
            "always-approve" => "always-approve".into(),
            "auto" => "auto".into(),
            // "ask" / "default" / unknown → ask (EchoAgent fails safe the same way)
            _ => "ask".into(),
        };
    }
    if let Some(m) = ui.get("approval_mode").and_then(Value::as_str) {
        return if m == "always-approve" {
            "always-approve".into()
        } else {
            "ask".into()
        };
    }
    if ui.get("yolo").and_then(Value::as_bool).unwrap_or(false) {
        return "always-approve".into();
    }
    "ask".into()
}

/// Read the mode that can actually be honored by the current machine and
/// organization policy. Every launch/session entry point uses this resolver,
/// so the desktop bridge can never bypass a Runtime hard pin.
pub fn read_permission_mode() -> String {
    let configured = crate::policy::locked_permission_mode()
        .unwrap_or_else(read_user_configured_permission_mode);
    effective_permission_mode(
        &configured,
        auto_mode_available(),
        always_approve_policy_block().is_none(),
    )
}

/// Mode inherited by a newly created or reloaded session. While a live
/// transition is unconfirmed, keep new sessions on the last acknowledged
/// mode instead of creating a mixed-permission Runtime.
pub(crate) fn permission_mode_for_session() -> String {
    let desired_mode = read_permission_mode();
    let runtime = runtime_permission_sync().lock().unwrap();
    if runtime.state != PermissionRuntimeSyncState::Offline {
        if let Some(mode) = runtime.applied_mode.as_ref() {
            if matches!(
                runtime.state,
                PermissionRuntimeSyncState::Syncing | PermissionRuntimeSyncState::Failed
            ) || mode != &desired_mode
            {
                return mode.clone();
            }
        }
    }
    desired_mode
}

/// Persist the mode to `[ui] permission_mode`. Other `[ui]` keys are preserved;
/// legacy `approval_mode`/`yolo` keys are removed so they can't shadow the new
/// value on old precedence paths.
pub fn write_permission_mode(mode: &str) -> Result<(), String> {
    if !PERMISSION_MODES.contains(&mode) {
        return Err(format!("unknown permission mode: {mode}"));
    }
    crate::providers::update_config(|config| {
        let root = config.as_table_mut().ok_or("config root is not a table")?;
        if !root.contains_key("ui") {
            root.insert("ui".into(), Value::Table(Map::new()));
        }
        let ui = root.get_mut("ui").and_then(Value::as_table_mut).unwrap();
        ui.insert("permission_mode".into(), Value::String(mode.into()));
        ui.remove("approval_mode");
        ui.remove("yolo");
        Ok(())
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionModeStatus {
    /// Effective mode the Runtime can honor now.
    pub permission_mode: String,
    /// Configured or policy-selected mode before the Auto capability clamp.
    pub configured_permission_mode: String,
    pub auto_mode_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_mode_unavailable_reason: Option<String>,
    pub always_approve_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub always_approve_unavailable_reason: Option<String>,
    pub locked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locked_reason: Option<String>,
    pub runtime_sync_state: PermissionRuntimeSyncState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_applied_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_sync_error: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PermissionRuntimeSyncState {
    #[default]
    Offline,
    Syncing,
    Synced,
    Failed,
}

#[derive(Debug, Clone, Default)]
struct RuntimePermissionSync {
    state: PermissionRuntimeSyncState,
    applied_mode: Option<String>,
    error: Option<String>,
}

fn runtime_permission_sync() -> &'static Mutex<RuntimePermissionSync> {
    static STATE: OnceLock<Mutex<RuntimePermissionSync>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(RuntimePermissionSync::default()))
}

pub(crate) fn permission_transition_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

pub(crate) fn mark_runtime_permission_mode_syncing() {
    let mut runtime = runtime_permission_sync().lock().unwrap();
    runtime.state = PermissionRuntimeSyncState::Syncing;
    runtime.error = None;
}

pub(crate) fn mark_runtime_permission_mode_starting(mode: &str) {
    *runtime_permission_sync().lock().unwrap() = RuntimePermissionSync {
        state: PermissionRuntimeSyncState::Syncing,
        applied_mode: Some(mode.into()),
        error: None,
    };
}

pub(crate) fn mark_runtime_permission_mode_synced(mode: &str) {
    *runtime_permission_sync().lock().unwrap() = RuntimePermissionSync {
        state: PermissionRuntimeSyncState::Synced,
        applied_mode: Some(mode.into()),
        error: None,
    };
}

pub(crate) fn mark_runtime_permission_mode_failed(error: impl Into<String>) {
    let mut runtime = runtime_permission_sync().lock().unwrap();
    runtime.state = PermissionRuntimeSyncState::Failed;
    runtime.error = Some(error.into());
}

pub(crate) fn mark_runtime_permission_mode_offline(error: Option<String>) {
    *runtime_permission_sync().lock().unwrap() = RuntimePermissionSync {
        state: PermissionRuntimeSyncState::Offline,
        applied_mode: None,
        error,
    };
}

/// Bridge-side automatic approval is allowed only after the running Runtime
/// positively acknowledged the same effective mode. Disk config alone is not
/// evidence that already-resident sessions changed.
pub(crate) fn is_runtime_permission_mode_active(mode: &str) -> bool {
    // Re-evaluate the current disk/organization policy on every bridge
    // decision. If policy became stricter after Runtime startup, stale
    // in-memory acknowledgement must never authorize automatic approval.
    if read_permission_mode() != mode {
        return false;
    }
    let runtime = runtime_permission_sync().lock().unwrap();
    runtime.state == PermissionRuntimeSyncState::Synced
        && runtime.applied_mode.as_deref() == Some(mode)
}

pub(crate) fn runtime_permission_mode_is_current() -> bool {
    let desired_mode = read_permission_mode();
    let runtime = runtime_permission_sync().lock().unwrap();
    runtime.state == PermissionRuntimeSyncState::Synced
        && runtime.applied_mode.as_deref() == Some(desired_mode.as_str())
}

pub(crate) fn permission_mode_status(agent_running: bool) -> PermissionModeStatus {
    let policy_mode = crate::policy::locked_permission_mode();
    let configured_permission_mode = policy_mode
        .clone()
        .unwrap_or_else(read_user_configured_permission_mode);
    let auto_mode_available = auto_mode_available();
    let always_approve_unavailable_reason = always_approve_policy_block();
    let always_approve_available = always_approve_unavailable_reason.is_none();
    let permission_mode = effective_permission_mode(
        &configured_permission_mode,
        auto_mode_available,
        always_approve_available,
    );
    let mut runtime = runtime_permission_sync().lock().unwrap().clone();
    if agent_running
        && runtime.state == PermissionRuntimeSyncState::Synced
        && runtime
            .applied_mode
            .as_deref()
            .is_some_and(|applied| applied != permission_mode)
    {
        runtime.state = PermissionRuntimeSyncState::Failed;
        runtime.error = Some(
            "权限配置或组织策略已变化，但运行中的 Agent 尚未应用；请重试同步或重启 Agent".into(),
        );
    }
    PermissionModeStatus {
        permission_mode,
        configured_permission_mode,
        auto_mode_available,
        auto_mode_unavailable_reason: (!auto_mode_available)
            .then(|| AUTO_MODE_UNAVAILABLE_REASON.to_string()),
        always_approve_available,
        always_approve_unavailable_reason,
        locked: policy_mode.is_some(),
        locked_reason: policy_mode.map(|mode| format!("权限模式已被组织策略锁定为 {mode}")),
        runtime_sync_state: if agent_running {
            runtime.state
        } else {
            PermissionRuntimeSyncState::Offline
        },
        runtime_applied_mode: agent_running.then_some(runtime.applied_mode).flatten(),
        runtime_sync_error: runtime.error,
    }
}

/// Current effective permission mode and Auto-mode availability.
#[tauri::command]
pub fn permission_mode_get(state: State<'_, AppState>) -> PermissionModeStatus {
    let agent_running = state.tx.lock().unwrap().is_some();
    permission_mode_status(agent_running)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionModeSetResult {
    #[serde(flatten)]
    pub status: PermissionModeStatus,
    pub agent_running: bool,
    pub runtime_synced: bool,
    pub resolved_pending: usize,
    pub remaining_pending: usize,
    pub resolved_permissions: Vec<crate::bridge::PermissionClosedFrontend>,
}

async fn notify_runtime_permission_mode(
    tx: &echo_agent_acp::AcpAgentTx,
    mode: &str,
    session_ids: Option<&[String]>,
    exclude_session_ids: Option<&[String]>,
) -> Result<(), String> {
    let (yolo_mode, auto_mode) = permission_mode_flags(mode);
    let mut params = serde_json::json!({
        "permission_mode": mode,
        "yolo_mode": yolo_mode,
        "auto_mode": auto_mode,
        // Scope the update to sessions owned by this desktop client. Without
        // an explicit sender the Runtime intentionally updates every resident
        // session, including sessions belonging to another leader client.
        "clientIdentifier": crate::agent_runtime::DESKTOP_CLIENT_IDENTIFIER,
    });
    if let Some(session_ids) = session_ids {
        params["sessionIds"] = serde_json::json!(session_ids);
    }
    if let Some(exclude_session_ids) = exclude_session_ids {
        params["excludeSessionIds"] = serde_json::json!(exclude_session_ids);
    }
    let params = crate::ext::raw_params(&params);
    let notification =
        agent_client_protocol::ExtNotification::new("echo.agent/yolo_mode_changed", params);
    let response = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        echo_agent_acp::acp_send(notification, tx),
    )
    .await
    .map_err(|_| "运行中的 Agent 权限同步超时".to_string())?;
    response.map_err(|error| format!("运行中的 Agent 权限同步失败：{error:?}"))
}

pub(crate) async fn sync_runtime_session_permission_mode(
    tx: &echo_agent_acp::AcpAgentTx,
    session_id: &str,
    mode: &str,
) -> Result<(), String> {
    notify_runtime_permission_mode(tx, mode, Some(&[session_id.to_string()]), None).await
}

fn permission_mode_rank(mode: &str) -> u8 {
    match mode {
        "always-approve" => 2,
        "auto" => 1,
        _ => 0,
    }
}

/// Set the permission mode: persist to config.toml (for future launches) AND
/// notify the running agent via EchoAgent's `echo.agent/yolo_mode_changed` extension
/// notification so existing sessions switch immediately. Switching to
/// always-approve also resolves requests that were parked before the switch.
#[tauri::command]
pub async fn permission_mode_set(
    app: AppHandle,
    state: State<'_, AppState>,
    permissions: State<'_, Permissions>,
    mode: String,
) -> Result<PermissionModeSetResult, String> {
    let _transition_guard = permission_transition_lock().lock().await;
    let auto_available = auto_mode_available();
    let always_available = always_approve_policy_block().is_none();
    validate_permission_mode_selection(&mode, auto_available, always_available)?;
    if let Some(locked) = crate::policy::locked_permission_mode() {
        if locked != mode {
            return Err(format!("权限模式已被策略锁定为 {locked}"));
        }
    } else {
        write_permission_mode(&mode)?;
    }

    let tx = state.tx.lock().unwrap().clone();
    let mut agent_running = tx.is_some();
    let previous_runtime = runtime_permission_sync().lock().unwrap().clone();
    let mut runtime_synced = false;
    if let Some(tx) = tx.as_ref() {
        mark_runtime_permission_mode_syncing();
        let excluded_sessions = crate::automations::full_access_session_ids();
        let mut sync_error = None;
        for attempt in 1..=2 {
            match notify_runtime_permission_mode(tx, &mode, None, Some(&excluded_sessions)).await {
                Ok(()) => {
                    runtime_synced = true;
                    break;
                }
                Err(error) => {
                    tracing::warn!(%error, attempt, permission_mode = %mode, "permission mode runtime sync was not acknowledged");
                    sync_error = Some(error);
                }
            }
        }
        if runtime_synced {
            mark_runtime_permission_mode_synced(&mode);
        } else {
            let mut error =
                sync_error.unwrap_or_else(|| "运行中的 Agent 未确认权限同步".to_string());
            let lowering = previous_runtime
                .applied_mode
                .as_deref()
                .is_some_and(|applied| permission_mode_rank(&mode) < permission_mode_rank(applied));
            let mut rollback_synced = false;
            if !lowering {
                if let Some(previous_mode) = previous_runtime.applied_mode.as_deref() {
                    let mut rollback_error = None;
                    for attempt in 1..=2 {
                        match notify_runtime_permission_mode(
                            tx,
                            previous_mode,
                            None,
                            Some(&excluded_sessions),
                        )
                        .await
                        {
                            Ok(()) => {
                                rollback_synced = true;
                                break;
                            }
                            Err(rollback_failure) => {
                                tracing::warn!(
                                    %rollback_failure,
                                    attempt,
                                    permission_mode = %previous_mode,
                                    "permission mode rollback was not acknowledged"
                                );
                                rollback_error = Some(rollback_failure);
                            }
                        }
                    }
                    if rollback_synced {
                        if previous_mode == mode {
                            runtime_synced = true;
                            mark_runtime_permission_mode_synced(&mode);
                        } else {
                            error = format!(
                                "{error}；运行中会话已安全恢复为上次确认的权限模式 {previous_mode}"
                            );
                            mark_runtime_permission_mode_failed(error.clone());
                        }
                    } else if let Some(rollback_error) = rollback_error {
                        error = format!("{error}；回滚也未获确认：{rollback_error}");
                    }
                }
            }
            if !runtime_synced && !rollback_synced {
                mark_runtime_permission_mode_failed(error.clone());
            }
            if !runtime_synced
                && !rollback_synced
                && state.mark_runtime_dead_if_current(tx, error.clone())
            {
                agent_running = false;
                mark_runtime_permission_mode_offline(Some(format!(
                    "{error}；为避免继续使用未确认的权限状态，Agent 已安全停止"
                )));
                let _ = app.emit("agent://agent-died", serde_json::json!({ "reason": error }));
            }
        }
    } else {
        mark_runtime_permission_mode_offline(None);
    }

    // Resolve already parked requests only after the Runtime acknowledged the
    // transition; persisted configuration alone is not an applied mode.
    let closed = if mode == "always-approve" && runtime_synced {
        permissions.approve_all_pending().await
    } else {
        Vec::new()
    };
    for notice in closed.iter().cloned() {
        emit_permission_closed(&app, notice);
    }
    let remaining_pending = permissions.list(None).await.len();
    let result = PermissionModeSetResult {
        status: permission_mode_status(agent_running),
        agent_running,
        runtime_synced,
        resolved_pending: closed.len(),
        remaining_pending,
        resolved_permissions: closed,
    };
    let _ = app.emit("agent://permission-mode", &result);
    Ok(result)
}

// ---------- unit tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    // --- parse_compact_rule ---

    #[test]
    fn parse_tool_with_pattern() {
        let rule = parse_compact_rule("Bash(git *)", "allow");
        assert_eq!(rule.action, "allow");
        assert_eq!(rule.tool, "bash");
        assert_eq!(rule.pattern.as_deref(), Some("git *"));
    }

    #[test]
    fn parse_tool_without_pattern() {
        let rule = parse_compact_rule("Read", "deny");
        assert_eq!(rule.action, "deny");
        assert_eq!(rule.tool, "read");
        assert_eq!(rule.pattern, None);
    }

    #[test]
    fn parse_tool_with_empty_parens() {
        let rule = parse_compact_rule("Edit()", "allow");
        assert_eq!(rule.tool, "edit");
        assert_eq!(rule.pattern, None);
    }

    #[test]
    fn parse_tool_with_complex_pattern() {
        let rule = parse_compact_rule("Bash(rm -rf /)", "deny");
        assert_eq!(rule.tool, "bash");
        assert_eq!(rule.pattern.as_deref(), Some("rm -rf /"));
    }

    #[test]
    fn parse_tool_with_nested_parens_in_pattern() {
        let rule = parse_compact_rule("Bash(echo (hello))", "allow");
        assert_eq!(rule.tool, "bash");
        // trim_end_matches(')') strips ALL trailing ')' chars
        assert_eq!(rule.pattern.as_deref(), Some("echo (hello"));
    }

    // --- rule_to_compact ---

    #[test]
    fn compact_with_pattern() {
        let rule = PermissionRule {
            action: "allow".into(),
            tool: "bash".into(),
            pattern: Some("git *".into()),
        };
        assert_eq!(rule_to_compact(&rule), "Bash(git *)");
    }

    #[test]
    fn compact_without_pattern() {
        let rule = PermissionRule {
            action: "deny".into(),
            tool: "read".into(),
            pattern: None,
        };
        assert_eq!(rule_to_compact(&rule), "Read");
    }

    #[test]
    fn compact_empty_pattern_treated_as_none() {
        let rule = PermissionRule {
            action: "allow".into(),
            tool: "edit".into(),
            pattern: Some("".into()),
        };
        assert_eq!(rule_to_compact(&rule), "Edit");
    }

    // --- capitalize_tool ---

    #[test]
    fn capitalize_various() {
        assert_eq!(capitalize_tool("bash"), "Bash");
        assert_eq!(capitalize_tool("read"), "Read");
        assert_eq!(capitalize_tool("edit"), "Edit");
        assert_eq!(capitalize_tool("mcp"), "Mcp");
        assert_eq!(capitalize_tool(""), "");
        assert_eq!(capitalize_tool("a"), "A");
    }

    // --- round-trip: parse → to_compact ---

    #[test]
    fn roundtrip_compact_rules() {
        let cases = vec![
            ("Bash(git *)", "allow"),
            ("Read", "deny"),
            ("Edit(/tmp/**)", "allow"),
            ("Bash(rm -rf *)", "deny"),
        ];
        for (input, action) in cases {
            let rule = parse_compact_rule(input, action);
            let output = rule_to_compact(&rule);
            assert_eq!(output, input, "round-trip failed for {input}");
        }
    }

    // --- AgentDefaults ---

    #[test]
    fn agent_defaults_default() {
        let d = AgentDefaults::default();
        assert_eq!(d.default_model, "");
        assert_eq!(d.default_permission, "");
        assert_eq!(d.remember_tool_approvals, None);
    }

    // --- PERMISSION_MODES ---

    #[test]
    fn permission_modes_constant() {
        assert_eq!(PERMISSION_MODES, ["ask", "auto", "always-approve"]);
    }

    #[test]
    fn permission_mode_flags_are_mutually_exclusive() {
        assert_eq!(permission_mode_flags("ask"), (false, false));
        assert_eq!(permission_mode_flags("auto"), (false, true));
        assert_eq!(permission_mode_flags("always-approve"), (true, false));
    }

    #[test]
    fn unavailable_auto_mode_falls_back_to_effective_ask_without_losing_configuration() {
        assert_eq!(effective_permission_mode("auto", false, true), "ask");
        assert_eq!(effective_permission_mode("auto", true, true), "auto");
        assert_eq!(
            effective_permission_mode("always-approve", true, false),
            "ask"
        );
    }

    #[test]
    fn unavailable_auto_mode_is_rejected_before_persistence() {
        assert_eq!(
            validate_permission_mode_selection("auto", false, true),
            Err(AUTO_MODE_UNAVAILABLE_REASON.into())
        );
        assert!(validate_permission_mode_selection("auto", true, true).is_ok());
        assert!(validate_permission_mode_selection("ask", false, false).is_ok());
        assert!(validate_permission_mode_selection("always-approve", true, true).is_ok());
        assert!(validate_permission_mode_selection("always-approve", true, false).is_err());
        assert!(validate_permission_mode_selection("invalid", true, true).is_err());
    }

    #[tokio::test]
    async fn runtime_notification_carries_mode_flags_and_waits_for_ack() {
        let (client, mut agent) = echo_agent_acp::acp_channels();
        let task = tokio::spawn(async move {
            notify_runtime_permission_mode(&client.tx, "always-approve", None, None).await
        });
        let message = agent.rx.recv().await.expect("permission mode notification");
        let echo_agent_acp::AcpAgentMessage::ExtNotification(arguments) = message else {
            panic!("expected ExtNotification")
        };
        assert_eq!(
            arguments.request.method.as_ref(),
            "echo.agent/yolo_mode_changed"
        );
        let params: serde_json::Value =
            serde_json::from_str(arguments.request.params.get()).expect("notification params");
        assert_eq!(params["permission_mode"], "always-approve");
        assert_eq!(params["yolo_mode"], true);
        assert_eq!(params["auto_mode"], false);
        assert_eq!(
            params["clientIdentifier"],
            crate::agent_runtime::DESKTOP_CLIENT_IDENTIFIER
        );
        arguments.response_tx.send(Ok(())).expect("send ack");
        assert!(task.await.expect("notification task").is_ok());
    }

    #[tokio::test]
    async fn runtime_notification_preserves_session_scope() {
        let (client, mut agent) = echo_agent_acp::acp_channels();
        let task = tokio::spawn(async move {
            let included = vec!["automation-session".to_string()];
            let excluded = vec!["interactive-session".to_string()];
            notify_runtime_permission_mode(&client.tx, "ask", Some(&included), Some(&excluded))
                .await
        });
        let message = agent.rx.recv().await.expect("permission mode notification");
        let echo_agent_acp::AcpAgentMessage::ExtNotification(arguments) = message else {
            panic!("expected ExtNotification")
        };
        let params: serde_json::Value =
            serde_json::from_str(arguments.request.params.get()).expect("notification params");
        assert_eq!(
            params["sessionIds"],
            serde_json::json!(["automation-session"])
        );
        assert_eq!(
            params["excludeSessionIds"],
            serde_json::json!(["interactive-session"])
        );
        arguments.response_tx.send(Ok(())).expect("send ack");
        assert!(task.await.expect("notification task").is_ok());
    }
}
