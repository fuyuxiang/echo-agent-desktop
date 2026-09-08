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

/// Runtime flags corresponding to the canonical desktop permission mode.
/// Keeping this mapping in one place prevents launch defaults and per-session
/// metadata from drifting apart.
pub(crate) fn permission_mode_flags(mode: &str) -> (bool, bool) {
    (mode == "always-approve", mode == "auto")
}

fn auto_mode_available() -> bool {
    echo_agent_runtime::util::config::auto_permission_mode_enabled_from_disk()
}

fn effective_permission_mode(configured_mode: &str, auto_available: bool) -> String {
    if configured_mode == "auto" && !auto_available {
        "ask".into()
    } else {
        configured_mode.into()
    }
}

fn validate_permission_mode_selection(mode: &str, auto_available: bool) -> Result<(), String> {
    if !PERMISSION_MODES.contains(&mode) {
        return Err(format!("unknown permission mode: {mode}"));
    }
    if mode == "auto" && !auto_available {
        return Err(AUTO_MODE_UNAVAILABLE_REASON.into());
    }
    Ok(())
}

/// Read the configured permission mode. Mirrors EchoAgent's precedence:
/// `permission_mode` > legacy `approval_mode` > legacy `yolo`; default "ask".
pub fn read_permission_mode() -> String {
    if let Some(mode) = crate::policy::locked_permission_mode() {
        return mode;
    }
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
}

fn permission_mode_status() -> PermissionModeStatus {
    let configured_permission_mode = read_permission_mode();
    let auto_mode_available = auto_mode_available();
    PermissionModeStatus {
        permission_mode: effective_permission_mode(
            &configured_permission_mode,
            auto_mode_available,
        ),
        configured_permission_mode,
        auto_mode_available,
        auto_mode_unavailable_reason: (!auto_mode_available)
            .then(|| AUTO_MODE_UNAVAILABLE_REASON.to_string()),
    }
}

/// Current effective permission mode and Auto-mode availability.
#[tauri::command]
pub fn permission_mode_get(_state: State<'_, AppState>) -> PermissionModeStatus {
    permission_mode_status()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionModeSetResult {
    pub permission_mode: String,
    pub agent_running: bool,
    pub runtime_synced: bool,
    pub resolved_pending: usize,
    pub remaining_pending: usize,
    pub resolved_permissions: Vec<crate::bridge::PermissionClosedFrontend>,
}

async fn notify_runtime_permission_mode(
    tx: &echo_agent_acp::AcpAgentTx,
    mode: &str,
) -> Result<(), String> {
    let (yolo_mode, auto_mode) = permission_mode_flags(mode);
    let params = crate::ext::raw_params(&serde_json::json!({
        "permission_mode": mode,
        "yolo_mode": yolo_mode,
        "auto_mode": auto_mode,
        // Scope the update to sessions owned by this desktop client. Without
        // an explicit sender the Runtime intentionally updates every resident
        // session, including sessions belonging to another leader client.
        "clientIdentifier": crate::agent_runtime::DESKTOP_CLIENT_IDENTIFIER,
    }));
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
    validate_permission_mode_selection(&mode, auto_mode_available())?;
    if let Some(locked) = crate::policy::locked_permission_mode() {
        if locked != mode {
            return Err(format!("权限模式已被策略锁定为 {locked}"));
        }
    }
    write_permission_mode(&mode)?;

    // A permission request can already be parked by the time the picker is
    // changed. Resolve those requests immediately; otherwise the UI would say
    // "always allow" while an old approval card remained blocked on a oneshot.
    let closed = if mode == "always-approve" {
        permissions.approve_all_pending().await
    } else {
        Vec::new()
    };
    for notice in closed.iter().cloned() {
        emit_permission_closed(&app, notice);
    }
    let remaining_pending = permissions.list(None).await.len();

    let tx = state.tx.lock().unwrap().clone();
    let agent_running = tx.is_some();
    let runtime_synced = match tx.as_ref() {
        Some(tx) => match notify_runtime_permission_mode(tx, &mode).await {
            Ok(()) => true,
            Err(error) => {
                // The persisted mode and bridge-side auto-approval remain
                // authoritative even if a dying Runtime cannot acknowledge.
                tracing::warn!(%error, permission_mode = %mode, "permission mode runtime sync was not acknowledged");
                false
            }
        },
        None => false,
    };
    let result = PermissionModeSetResult {
        permission_mode: mode,
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
        assert_eq!(effective_permission_mode("auto", false), "ask");
        assert_eq!(effective_permission_mode("auto", true), "auto");
        assert_eq!(
            effective_permission_mode("always-approve", false),
            "always-approve"
        );
    }

    #[test]
    fn unavailable_auto_mode_is_rejected_before_persistence() {
        assert_eq!(
            validate_permission_mode_selection("auto", false),
            Err(AUTO_MODE_UNAVAILABLE_REASON.into())
        );
        assert!(validate_permission_mode_selection("auto", true).is_ok());
        assert!(validate_permission_mode_selection("ask", false).is_ok());
        assert!(validate_permission_mode_selection("always-approve", false).is_ok());
        assert!(validate_permission_mode_selection("invalid", true).is_err());
    }

    #[tokio::test]
    async fn runtime_notification_carries_mode_flags_and_waits_for_ack() {
        let (client, mut agent) = echo_agent_acp::acp_channels();
        let task = tokio::spawn(async move {
            notify_runtime_permission_mode(&client.tx, "always-approve").await
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
}
