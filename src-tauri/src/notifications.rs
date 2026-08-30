//! EchoAgent notification log — a local inbox for EchoAgent events.
//!
//! EchoAgent's "智能体邮箱" (agent mailbox) is a Tencent email integration
//! (send/receive mail, turn emails into tasks). EchoAgent has no email backend,
//! so EchoAgent redefines this tab as a **session notification center**:
//! every interesting EchoAgent event (permission request, folder-trust prompt,
//! task completion, plan-mode toggle, MCP status change, session summary) is
//! appended here as a notification the user can browse, filter, and act on.
//!
//! Storage: `~/.echo-agent/echoagent-notifications.json` (capped at 200 entries;
//! older entries drop off FIFO).

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_notification::NotificationExt;

use crate::commands::AppState;

/// Notification kind. Mirrors the EchoAgent event channels we already subscribe to.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NotificationKind {
    Permission,
    FolderTrust,
    TaskUpdate,
    PlanMode,
    McpStatus,
    ModelsUpdate,
    Summary,
    SessionComplete,
    Error,
    Info,
}

impl NotificationKind {
    fn from_str(s: &str) -> Self {
        match s {
            "permission" => Self::Permission,
            "folder_trust" | "folder-trust" => Self::FolderTrust,
            "task_update" | "task-update" => Self::TaskUpdate,
            "plan_mode" | "plan-mode" => Self::PlanMode,
            "mcp_status" | "mcp-status" => Self::McpStatus,
            "models_update" | "models-update" => Self::ModelsUpdate,
            "summary" => Self::Summary,
            "session_complete" | "complete" => Self::SessionComplete,
            "error" => Self::Error,
            _ => Self::Info,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationEntry {
    /// Monotonic id (timestamp-based).
    pub id: u64,
    pub kind: NotificationKind,
    /// ISO timestamp.
    pub at: String,
    /// Human-readable title.
    pub title: String,
    /// Optional detail/body (raw event JSON or short text).
    #[serde(default)]
    pub body: Option<String>,
    /// Optional related session id (for permission/summary/etc.).
    #[serde(default)]
    pub session_id: Option<String>,
    /// Severity: "info" | "warn" | "error".
    #[serde(default = "default_severity")]
    pub severity: String,
    /// Whether the user has dismissed/read this entry.
    #[serde(default)]
    pub read: bool,
}

fn default_severity() -> String {
    "info".into()
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct NotificationStore {
    #[serde(default)]
    pub entries: Vec<NotificationEntry>,
}

const MAX_ENTRIES: usize = 200;
static LOG_ACCESS: OnceLock<Mutex<()>> = OnceLock::new();

fn log_access() -> &'static Mutex<()> {
    LOG_ACCESS.get_or_init(|| Mutex::new(()))
}

fn store_path() -> PathBuf {
    crate::paths::echo_agent_home_dir().join("echoagent-notifications.json")
}

/// Read the notification log. Missing/corrupt → empty.
pub fn read_store() -> NotificationStore {
    let Ok(content) = std::fs::read_to_string(store_path()) else {
        return NotificationStore::default();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

/// Atomic write.
fn write_store(store: &NotificationStore) -> Result<(), String> {
    let path = store_path();
    let body =
        serde_json::to_string_pretty(store).map_err(|e| format!("serialize notifications: {e}"))?;
    crate::paths::write_private_file(&path, body.as_bytes())
}

/// Append a notification. Called by the frontend (via command) when it
/// receives a EchoAgent event it wants logged. Caps the log at MAX_ENTRIES.
pub fn append(
    kind: NotificationKind,
    title: &str,
    body: Option<&str>,
    session_id: Option<&str>,
    severity: &str,
) {
    let _guard = log_access().lock().unwrap();
    let mut store = read_store();
    let id = store.entries.last().map(|e| e.id + 1).unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(1)
    });
    let at = chrono::Local::now().to_rfc3339();
    store.entries.push(NotificationEntry {
        id,
        kind,
        at,
        title: title.to_string(),
        body: body.map(String::from),
        session_id: session_id.map(String::from),
        severity: severity.to_string(),
        read: false,
    });
    // FIFO cap.
    if store.entries.len() > MAX_ENTRIES {
        let excess = store.entries.len() - MAX_ENTRIES;
        store.entries.drain(0..excess);
    }
    let _ = write_store(&store);
}

// ---------- Tauri commands ----------

/// Append a notification (frontend calls this when it receives a EchoAgent event).
#[tauri::command]
pub fn notification_append(
    _state: State<'_, AppState>,
    kind: String,
    title: String,
    body: Option<String>,
    session_id: Option<String>,
    severity: Option<String>,
) {
    append(
        NotificationKind::from_str(&kind),
        &title,
        body.as_deref(),
        session_id.as_deref(),
        severity.as_deref().unwrap_or("info"),
    );
}

/// List notifications (newest first).
#[tauri::command]
pub fn notification_list(_state: State<'_, AppState>) -> Vec<NotificationEntry> {
    let _guard = log_access().lock().unwrap();
    let mut entries = read_store().entries;
    entries.reverse();
    entries
}

/// Mark a notification as read.
#[tauri::command]
pub fn notification_mark_read(_state: State<'_, AppState>, id: u64) -> Result<(), String> {
    let _guard = log_access().lock().unwrap();
    let mut store = read_store();
    for e in &mut store.entries {
        if e.id == id {
            e.read = true;
        }
    }
    write_store(&store)
}

/// Mark all as read.
#[tauri::command]
pub fn notification_mark_all_read(_state: State<'_, AppState>) -> Result<(), String> {
    let _guard = log_access().lock().unwrap();
    let mut store = read_store();
    for e in &mut store.entries {
        e.read = true;
    }
    write_store(&store)
}

/// Clear all notifications.
#[tauri::command]
pub fn notification_clear(_state: State<'_, AppState>) -> Result<(), String> {
    let _guard = log_access().lock().unwrap();
    write_store(&NotificationStore::default())
}

// ---------- external notification channels ----------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ChannelKind {
    SlackWebhook,
    DiscordWebhook,
    GenericWebhook,
    Email,
    Desktop,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyChannel {
    pub id: String,
    pub label: String,
    pub kind: ChannelKind,
    #[serde(default)]
    pub endpoint: Option<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyMessage {
    pub title: String,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default = "default_severity")]
    pub level: String,
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryResult {
    pub id: String,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ChannelStore {
    #[serde(default)]
    channels: Vec<NotifyChannel>,
}

static CHANNEL_ACCESS: OnceLock<Mutex<()>> = OnceLock::new();

fn channel_access() -> &'static Mutex<()> {
    CHANNEL_ACCESS.get_or_init(|| Mutex::new(()))
}

fn channels_path() -> PathBuf {
    crate::paths::echo_agent_home_dir().join("echoagent-notify-channels.json")
}

fn read_channels() -> ChannelStore {
    let Ok(raw) = std::fs::read_to_string(channels_path()) else {
        return ChannelStore::default();
    };
    let mut store: ChannelStore = serde_json::from_str(&raw).unwrap_or_default();
    // Opening a mailto draft is not delivery. Old builds exposed that as an
    // email channel, so keep legacy entries visible/removable but never run
    // them from background agent events.
    for channel in &mut store.channels {
        if channel.kind == ChannelKind::Email {
            channel.enabled = false;
        }
    }
    store
}

fn write_channels(store: &ChannelStore) -> Result<(), String> {
    let raw = serde_json::to_vec_pretty(store).map_err(|e| format!("serialize channels: {e}"))?;
    crate::paths::write_private_file(&channels_path(), &raw)
}

fn validate_channel(channel: &NotifyChannel) -> Result<(), String> {
    if channel.id.trim().is_empty() || channel.label.trim().is_empty() {
        return Err("渠道 id 和显示名不能为空".into());
    }
    match channel.kind {
        ChannelKind::SlackWebhook | ChannelKind::DiscordWebhook | ChannelKind::GenericWebhook => {
            let endpoint = channel.endpoint.as_deref().unwrap_or_default();
            let url = reqwest::Url::parse(endpoint)
                .map_err(|error| format!("Webhook endpoint URL 无效：{error}"))?;
            let loopback = url.host_str().is_some_and(|host| {
                host.eq_ignore_ascii_case("localhost")
                    || host
                        .parse::<std::net::IpAddr>()
                        .is_ok_and(|address| address.is_loopback())
            });
            if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
                return Err(
                    "Webhook endpoint 必须使用 HTTPS（本机 localhost/回环地址除外）".into(),
                );
            }
        }
        ChannelKind::Email => return Err("邮件自动投递需要 SMTP 凭据，当前版本未开放该渠道".into()),
        ChannelKind::Desktop => {}
    }
    Ok(())
}

#[tauri::command]
pub fn notify_channels_list() -> Vec<NotifyChannel> {
    let _guard = channel_access().lock().unwrap();
    read_channels()
        .channels
        .into_iter()
        .map(|mut channel| {
            if let Some(endpoint) = channel.endpoint.as_deref() {
                channel.endpoint = match channel.kind {
                    ChannelKind::Desktop => None,
                    ChannelKind::Email => endpoint
                        .split_once('@')
                        .map(|(_, domain)| format!("***@{domain}")),
                    _ => reqwest::Url::parse(endpoint).ok().map(|url| {
                        format!(
                            "{}://{}/…",
                            url.scheme(),
                            url.host_str().unwrap_or("configured")
                        )
                    }),
                };
            }
            channel
        })
        .collect()
}

#[tauri::command]
pub fn notify_channel_upsert(channel: NotifyChannel) -> Result<(), String> {
    crate::policy::require_feature("notifications")?;
    validate_channel(&channel)?;
    let _guard = channel_access().lock().unwrap();
    let mut store = read_channels();
    if let Some(existing) = store.channels.iter_mut().find(|item| item.id == channel.id) {
        *existing = channel;
    } else {
        store.channels.push(channel);
    }
    write_channels(&store)
}

#[tauri::command]
pub fn notify_channel_remove(id: String) -> Result<(), String> {
    let _guard = channel_access().lock().unwrap();
    let mut store = read_channels();
    store.channels.retain(|channel| channel.id != id);
    write_channels(&store)
}

#[tauri::command]
pub fn notify_channel_set_enabled(id: String, enabled: bool) -> Result<(), String> {
    let _guard = channel_access().lock().unwrap();
    let mut store = read_channels();
    let channel = store
        .channels
        .iter_mut()
        .find(|channel| channel.id == id)
        .ok_or_else(|| format!("通知渠道 {id} 不存在"))?;
    if enabled && channel.kind == ChannelKind::Email {
        return Err("邮件自动投递尚未配置，请使用 Webhook 渠道".into());
    }
    channel.enabled = enabled;
    write_channels(&store)
}

fn payload(channel: &NotifyChannel, message: &NotifyMessage) -> serde_json::Value {
    match channel.kind {
        ChannelKind::SlackWebhook => serde_json::json!({
            "text": format!("{} {}", level_emoji(&message.level), message.title),
            "blocks": [{"type":"section", "text":{"type":"mrkdwn", "text": format!("*{} {}*{}", level_emoji(&message.level), message.title, message.body.as_deref().map(|b| format!("\n{b}")).unwrap_or_default())}}]
        }),
        ChannelKind::DiscordWebhook => serde_json::json!({
            "content": message.title,
            "embeds": [{"title": message.title, "description": message.body, "color": if message.level == "error" { 0xdc2626 } else if message.level == "warn" { 0xd97706 } else { 0x0ea5e9 }}]
        }),
        _ => serde_json::json!({
            "title": message.title,
            "body": message.body,
            "level": message.level,
            "sessionId": message.session_id,
            "timestamp": chrono::Local::now().to_rfc3339(),
        }),
    }
}

fn level_emoji(level: &str) -> &'static str {
    match level {
        "error" => "🔴",
        "warn" => "🟡",
        _ => "🔵",
    }
}

async fn send_one(
    app: &AppHandle,
    channel: &NotifyChannel,
    message: &NotifyMessage,
) -> Result<(), String> {
    match channel.kind {
        ChannelKind::Desktop => app
            .notification()
            .builder()
            .title(&message.title)
            .body(message.body.as_deref().unwrap_or_default())
            .show()
            .map_err(|e| format!("system notification: {e}")),
        ChannelKind::Email => Err("邮件自动投递未配置".into()),
        ChannelKind::SlackWebhook | ChannelKind::DiscordWebhook | ChannelKind::GenericWebhook => {
            let endpoint = channel.endpoint.as_deref().ok_or("missing endpoint")?;
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .map_err(|e| format!("HTTP client: {e}"))?;
            let body = payload(channel, message);
            let mut last_error = String::new();
            for attempt in 0..3 {
                match client.post(endpoint).json(&body).send().await {
                    Ok(response) if response.status().is_success() => return Ok(()),
                    Ok(response) => last_error = format!("HTTP {}", response.status()),
                    Err(error) => last_error = error.to_string(),
                }
                if attempt < 2 {
                    tokio::time::sleep(Duration::from_millis(250 * (attempt + 1))).await;
                }
            }
            Err(last_error)
        }
    }
}

pub async fn dispatch_external(
    app: &AppHandle,
    message: NotifyMessage,
    only_id: Option<&str>,
) -> Vec<DeliveryResult> {
    if crate::policy::require_feature("notifications").is_err() {
        return Vec::new();
    }
    let channels = {
        let _guard = channel_access().lock().unwrap();
        read_channels()
            .channels
            .into_iter()
            .filter(|channel| channel.enabled)
            .filter(|channel| only_id.map(|id| channel.id == id).unwrap_or(true))
            .collect::<Vec<_>>()
    };
    let mut results = Vec::with_capacity(channels.len());
    for channel in channels {
        match send_one(app, &channel, &message).await {
            Ok(()) => results.push(DeliveryResult {
                id: channel.id,
                ok: true,
                error: None,
            }),
            Err(error) => {
                append(
                    NotificationKind::Error,
                    "通知投递失败",
                    Some(&format!("{}：{error}", channel.label)),
                    message.session_id.as_deref(),
                    "error",
                );
                results.push(DeliveryResult {
                    id: channel.id,
                    ok: false,
                    error: Some(error),
                });
            }
        }
    }
    results
}

/// Deliver an opted-in automation result. A desktop notification is available
/// out of the box; adding an explicit desktop channel replaces this fallback,
/// while Slack/Discord/Webhook channels continue to receive the same message.
pub async fn dispatch_automation(app: &AppHandle, message: NotifyMessage) -> Vec<DeliveryResult> {
    if crate::policy::require_feature("notifications").is_err() {
        return Vec::new();
    }
    let desktop_configured = {
        let _guard = channel_access().lock().unwrap();
        read_channels()
            .channels
            .iter()
            .any(|channel| channel.kind == ChannelKind::Desktop)
    };
    let mut results = dispatch_external(app, message.clone(), None).await;
    if !desktop_configured {
        match app
            .notification()
            .builder()
            .title(&message.title)
            .body(message.body.as_deref().unwrap_or_default())
            .show()
        {
            Ok(()) => results.push(DeliveryResult {
                id: "builtin-desktop".into(),
                ok: true,
                error: None,
            }),
            Err(error) => {
                let error = format!("system notification: {error}");
                append(
                    NotificationKind::Error,
                    "通知投递失败",
                    Some(&error),
                    message.session_id.as_deref(),
                    "error",
                );
                results.push(DeliveryResult {
                    id: "builtin-desktop".into(),
                    ok: false,
                    error: Some(error),
                });
            }
        }
    }
    results
}

#[tauri::command]
pub async fn notify_channel_test(app: AppHandle, id: String) -> Result<DeliveryResult, String> {
    let results = dispatch_external(
        &app,
        NotifyMessage {
            title: "测试通知".into(),
            body: Some("来自 EchoAgent 的测试消息".into()),
            level: "info".into(),
            session_id: None,
        },
        Some(&id),
    )
    .await;
    results
        .into_iter()
        .next()
        .ok_or_else(|| "渠道不存在、未启用或被策略禁用".into())
}

// ---------- unit tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    // --- NotificationKind::from_str ---

    #[test]
    fn kind_from_str_known_variants() {
        assert!(matches!(
            NotificationKind::from_str("permission"),
            NotificationKind::Permission
        ));
        assert!(matches!(
            NotificationKind::from_str("folder_trust"),
            NotificationKind::FolderTrust
        ));
        assert!(matches!(
            NotificationKind::from_str("folder-trust"),
            NotificationKind::FolderTrust
        ));
        assert!(matches!(
            NotificationKind::from_str("task_update"),
            NotificationKind::TaskUpdate
        ));
        assert!(matches!(
            NotificationKind::from_str("task-update"),
            NotificationKind::TaskUpdate
        ));
        assert!(matches!(
            NotificationKind::from_str("plan_mode"),
            NotificationKind::PlanMode
        ));
        assert!(matches!(
            NotificationKind::from_str("plan-mode"),
            NotificationKind::PlanMode
        ));
        assert!(matches!(
            NotificationKind::from_str("mcp_status"),
            NotificationKind::McpStatus
        ));
        assert!(matches!(
            NotificationKind::from_str("mcp-status"),
            NotificationKind::McpStatus
        ));
        assert!(matches!(
            NotificationKind::from_str("models_update"),
            NotificationKind::ModelsUpdate
        ));
        assert!(matches!(
            NotificationKind::from_str("models-update"),
            NotificationKind::ModelsUpdate
        ));
        assert!(matches!(
            NotificationKind::from_str("summary"),
            NotificationKind::Summary
        ));
        assert!(matches!(
            NotificationKind::from_str("session_complete"),
            NotificationKind::SessionComplete
        ));
        assert!(matches!(
            NotificationKind::from_str("complete"),
            NotificationKind::SessionComplete
        ));
        assert!(matches!(
            NotificationKind::from_str("error"),
            NotificationKind::Error
        ));
    }

    #[test]
    fn kind_from_str_unknown_falls_back_to_info() {
        assert!(matches!(
            NotificationKind::from_str("unknown"),
            NotificationKind::Info
        ));
        assert!(matches!(
            NotificationKind::from_str(""),
            NotificationKind::Info
        ));
        assert!(matches!(
            NotificationKind::from_str("PERMISSION"),
            NotificationKind::Info
        ));
    }

    // --- default_severity ---

    #[test]
    fn default_severity_is_info() {
        assert_eq!(default_severity(), "info");
    }

    // --- NotificationStore serde ---

    #[test]
    fn store_default_is_empty() {
        let store = NotificationStore::default();
        assert!(store.entries.is_empty());
    }

    #[test]
    fn entry_serde_roundtrip() {
        let entry = NotificationEntry {
            id: 42,
            kind: NotificationKind::Permission,
            at: "2026-07-01T10:00:00+08:00".into(),
            title: "Test notification".into(),
            body: Some("details".into()),
            session_id: Some("sess-1".into()),
            severity: "warn".into(),
            read: false,
        };
        let json = serde_json::to_string(&entry).unwrap();
        let parsed: NotificationEntry = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, 42);
        assert_eq!(parsed.title, "Test notification");
        assert_eq!(parsed.severity, "warn");
        assert!(!parsed.read);
    }

    #[test]
    fn entry_deserialize_defaults() {
        // Missing optional fields should use defaults.
        // Note: serde rename_all = "camelCase" so variant is "info" not "Info".
        let json = r#"{"id":1,"kind":"info","at":"2026-01-01","title":"hi"}"#;
        let entry: NotificationEntry = serde_json::from_str(json).unwrap();
        assert_eq!(entry.severity, "info");
        assert!(!entry.read);
        assert!(entry.body.is_none());
        assert!(entry.session_id.is_none());
    }

    #[test]
    fn external_channel_validation_accepts_real_delivery_kinds_only() {
        let webhook = NotifyChannel {
            id: "slack".into(),
            label: "Slack".into(),
            kind: ChannelKind::SlackWebhook,
            endpoint: Some("https://hooks.example.test/abc".into()),
            enabled: true,
        };
        assert!(validate_channel(&webhook).is_ok());
        assert!(validate_channel(&NotifyChannel {
            kind: ChannelKind::Email,
            endpoint: Some("person@example.test".into()),
            ..webhook.clone()
        })
        .is_err());
        assert!(validate_channel(&NotifyChannel {
            kind: ChannelKind::GenericWebhook,
            endpoint: Some("file:///tmp/not-a-webhook".into()),
            ..webhook.clone()
        })
        .is_err());
        assert!(validate_channel(&NotifyChannel {
            kind: ChannelKind::GenericWebhook,
            endpoint: Some("http://hooks.example.test/insecure".into()),
            ..webhook.clone()
        })
        .is_err());
        assert!(validate_channel(&NotifyChannel {
            kind: ChannelKind::GenericWebhook,
            endpoint: Some("http://127.0.0.1:8080/hook".into()),
            ..webhook
        })
        .is_ok());
    }

    #[test]
    fn slack_payload_contains_title_and_body() {
        let value = payload(
            &NotifyChannel {
                id: "slack".into(),
                label: "Slack".into(),
                kind: ChannelKind::SlackWebhook,
                endpoint: Some("https://hooks.example.test/abc".into()),
                enabled: true,
            },
            &NotifyMessage {
                title: "Task complete".into(),
                body: Some("The scheduled task finished".into()),
                level: "info".into(),
                session_id: Some("session-1".into()),
            },
        );
        assert!(value["text"].as_str().unwrap().contains("Task complete"));
        assert!(value["blocks"][0]["text"]["text"]
            .as_str()
            .unwrap()
            .contains("scheduled task finished"));
    }
}
