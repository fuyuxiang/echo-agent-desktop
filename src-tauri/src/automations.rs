//! Automations (定时任务) — EchoAgent-managed local scheduler.
//!
//! EchoAgent only exposes `echo.agent/scheduler/delete` (deleting tasks it created itself
//! via tool calls). It does NOT let a client create new scheduled tasks.
//! EchoAgent's automation panel needs create/update/list, so EchoAgent keeps
//! its own automation table in `~/.echo-agent/echoagent-automations.json` and a run
//! record table in `~/.echo-agent/echoagent-automation-records.json`.
//!
//! Data model mirrors EchoAgent's automation panel 1:1:
//!  - scheduleType: "recurring" | "once"
//!  - recurring schedule: freq DAILY/WEEKLY/MONTHLY/YEARLY/HOURLY + interval
//!    (双周 = WEEKLY interval 2; 按间隔 = HOURLY + intervalHours) + byday /
//!    bymonthday / bymonth + byhour:byminute
//!  - once: scheduledDate (YYYY-MM-DD) + scheduledTime (HH:MM)
//!  - validity window: validFromDate / validUntilDate (recurring only)
//!  - extras: skills, expert, connectorIds, permissionMode, pushToWeChat
//!
//! At fire time the scheduler opens a fresh EchoAgent session in the automation's
//! cwd and sends the prompt; a run record (running → success/failed) is
//! written so the 运行记录 tab can render history.
//!
//! The scheduler runs in-process (tokio task), polling every minute.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, NaiveTime, Weekday};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
use tauri_plugin_autostart::ManagerExt;

use crate::commands::AppState;

// ---------- models ----------

/// RRULE-like frequency. Serialized as "DAILY" | "WEEKLY" | "MONTHLY" |
/// "YEARLY" | "HOURLY" to match the frontend model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ScheduleFreq {
    DAILY,
    WEEKLY,
    MONTHLY,
    YEARLY,
    HOURLY,
}

fn default_interval() -> u32 {
    1
}
fn default_hour() -> u32 {
    9
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationSchedule {
    pub freq: ScheduleFreq,
    /// 1 = every week, 2 = bi-weekly (WEEKLY only).
    #[serde(default = "default_interval")]
    pub interval: u32,
    /// Weekday codes "MO".."SU".
    #[serde(default)]
    pub byday: Vec<String>,
    /// Days of month 1..=31 (MONTHLY/YEARLY).
    #[serde(default)]
    pub bymonthday: Vec<u32>,
    /// Months 1..=12 (YEARLY).
    #[serde(default)]
    pub bymonth: Vec<u32>,
    #[serde(default = "default_hour")]
    pub byhour: u32,
    #[serde(default)]
    pub byminute: u32,
    /// 按间隔: every N hours (HOURLY).
    #[serde(default = "default_interval")]
    pub interval_hours: u32,
}

impl Default for AutomationSchedule {
    fn default() -> Self {
        Self {
            freq: ScheduleFreq::DAILY,
            interval: 1,
            byday: ALL_DAYS.iter().map(|s| s.to_string()).collect(),
            bymonthday: vec![],
            bymonth: vec![],
            byhour: 9,
            byminute: 0,
            interval_hours: 1,
        }
    }
}

const ALL_DAYS: [&str; 7] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    pub id: String,
    pub name: String,
    /// The prompt to send when this automation fires.
    pub prompt: String,
    /// Comma-separated workspace directories (first entry is the run cwd).
    #[serde(default)]
    pub cwds: String,
    /// "ACTIVE" | "PAUSED".
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default)]
    pub model_id: Option<String>,
    #[serde(default)]
    pub model_is_thinking: bool,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub expert_id: Option<String>,
    #[serde(default)]
    pub expert_name: Option<String>,
    #[serde(default)]
    pub connector_ids: Vec<String>,
    /// "fullAccess" | "default".
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    /// "recurring" | "once".
    #[serde(default = "default_schedule_type")]
    pub schedule_type: String,
    #[serde(default)]
    pub schedule: AutomationSchedule,
    /// Once mode: YYYY-MM-DD.
    #[serde(default)]
    pub scheduled_date: Option<String>,
    /// Once mode: HH:MM.
    #[serde(default)]
    pub scheduled_time: Option<String>,
    /// Recurring validity window (YYYY-MM-DD, inclusive).
    #[serde(default)]
    pub valid_from_date: Option<String>,
    #[serde(default)]
    pub valid_until_date: Option<String>,
    #[serde(default)]
    pub push_to_we_chat: bool,
    #[serde(default)]
    pub last_run_at: Option<String>,
    #[serde(default)]
    pub next_run_at: Option<String>,
    pub created_at: String,
}

fn default_status() -> String {
    "ACTIVE".into()
}
fn default_permission_mode() -> String {
    "default".into()
}
fn default_schedule_type() -> String {
    "recurring".into()
}

/// A single run-history entry (运行记录 / inbox item).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRunRecord {
    pub id: String,
    pub automation_id: String,
    pub automation_name: String,
    /// "running" | "success" | "failed".
    pub status: String,
    pub started_at: String,
    #[serde(default)]
    pub finished_at: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    /// Human-readable dispatch/runtime failure reason.
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub archived: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AutomationStore {
    #[serde(default)]
    pub automations: Vec<Automation>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct RunRecordStore {
    #[serde(default)]
    pub records: Vec<AutomationRunRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationSnapshot {
    pub automations: Vec<Automation>,
    pub records: Vec<AutomationRunRecord>,
}

// ---------- persistence ----------

fn store_path() -> PathBuf {
    crate::paths::echo_agent_home_dir().join("echoagent-automations.json")
}
fn records_path() -> PathBuf {
    crate::paths::echo_agent_home_dir().join("echoagent-automation-records.json")
}

static STORE_ACCESS: OnceLock<Mutex<()>> = OnceLock::new();
static RECORD_ACCESS: OnceLock<Mutex<()>> = OnceLock::new();
static FULL_ACCESS_SESSIONS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn store_access() -> &'static Mutex<()> {
    STORE_ACCESS.get_or_init(|| Mutex::new(()))
}

fn record_access() -> &'static Mutex<()> {
    RECORD_ACCESS.get_or_init(|| Mutex::new(()))
}

fn full_access_sessions() -> &'static Mutex<HashSet<String>> {
    FULL_ACCESS_SESSIONS.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn has_active_automations() -> bool {
    let _guard = store_access().lock().unwrap();
    read_store()
        .automations
        .iter()
        .any(|automation| automation.status == "ACTIVE")
}

pub fn should_keep_app_alive() -> bool {
    if has_active_automations() {
        return true;
    }
    let _guard = record_access().lock().unwrap();
    read_records()
        .records
        .iter()
        .any(|record| record.status == "running")
}

fn sync_autostart_enabled(app: &AppHandle, enabled: bool) {
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        let manager = app.autolaunch();
        let result = if enabled {
            manager.enable()
        } else {
            manager.disable()
        };
        if let Err(error) = result {
            tracing::warn!(%error, enabled, "failed to synchronize automation autostart");
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    let _ = (app, enabled);
}

pub fn sync_autostart_state(app: &AppHandle) {
    sync_autostart_enabled(app, has_active_automations());
}

fn write_json(path: &PathBuf, body: &str) -> Result<(), String> {
    crate::paths::write_private_file(path, body.as_bytes())
}

/// Read the automation store. Missing/corrupt → empty (never block on this).
/// Accepts the legacy v1 shape ({schedule:{type:"daily"|...}}, lowercase
/// status, single `cwd` string) and migrates it in memory.
fn read_store() -> AutomationStore {
    let Ok(content) = std::fs::read_to_string(store_path()) else {
        return AutomationStore::default();
    };
    if let Ok(store) = serde_json::from_str::<AutomationStore>(&content) {
        return store;
    }
    // Legacy fallback: reshape each automation object, then parse.
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&content) else {
        return AutomationStore::default();
    };
    migrate_legacy_json(&mut value);
    serde_json::from_value(value).unwrap_or_default()
}

/// Convert legacy v1 automation objects to the current model, in place.
fn migrate_legacy_json(root: &mut serde_json::Value) {
    let Some(items) = root.get_mut("automations").and_then(|a| a.as_array_mut()) else {
        return;
    };
    for item in items {
        let Some(obj) = item.as_object_mut() else {
            continue;
        };
        // status: "active"|"paused" → "ACTIVE"|"PAUSED"
        if let Some(status) = obj.get("status").and_then(|s| s.as_str()) {
            let upper = status.to_uppercase();
            obj.insert("status".into(), serde_json::Value::String(upper));
        }
        // cwd → cwds
        if !obj.contains_key("cwds") {
            if let Some(cwd) = obj.get("cwd").and_then(|c| c.as_str()) {
                obj.insert("cwds".into(), serde_json::Value::String(cwd.to_string()));
            }
        }
        obj.remove("cwd");
        // schedule {type: ...} → {freq: ...} (+ once fields)
        let Some(schedule) = obj.get("schedule").cloned() else {
            continue;
        };
        if schedule.get("freq").is_some() {
            continue; // already current
        }
        let Some(kind) = schedule.get("type").and_then(|t| t.as_str()) else {
            continue;
        };
        let parse_time = |key: &str| -> (u32, u32) {
            schedule
                .get(key)
                .and_then(|t| t.as_str())
                .and_then(|t| {
                    let mut parts = t.split(':');
                    let h = parts.next()?.parse().ok()?;
                    let m = parts.next()?.parse().ok()?;
                    Some((h, m))
                })
                .unwrap_or((9, 0))
        };
        let mut new_schedule = serde_json::json!({
            "freq": "DAILY",
            "interval": 1,
            "byday": ALL_DAYS,
            "bymonthday": [],
            "bymonth": [],
            "byhour": 9,
            "byminute": 0,
            "intervalHours": 1,
        });
        match kind {
            "once" => {
                obj.insert(
                    "scheduleType".into(),
                    serde_json::Value::String("once".into()),
                );
                if let Some(at) = schedule.get("at").and_then(|t| t.as_str()) {
                    if let Ok(dt) = DateTime::parse_from_rfc3339(at) {
                        let local = dt.with_timezone(&Local);
                        obj.insert(
                            "scheduledDate".into(),
                            serde_json::Value::String(local.format("%Y-%m-%d").to_string()),
                        );
                        obj.insert(
                            "scheduledTime".into(),
                            serde_json::Value::String(local.format("%H:%M").to_string()),
                        );
                    }
                }
            }
            "daily" => {
                let (h, m) = parse_time("time");
                new_schedule["byhour"] = h.into();
                new_schedule["byminute"] = m.into();
            }
            "weekly" => {
                let (h, m) = parse_time("time");
                new_schedule["freq"] = "WEEKLY".into();
                new_schedule["byhour"] = h.into();
                new_schedule["byminute"] = m.into();
                // legacy weekdays: 0=Sunday .. 6=Saturday
                let codes: Vec<&str> = schedule
                    .get("weekdays")
                    .and_then(|w| w.as_array())
                    .map(|days| {
                        days.iter()
                            .filter_map(|d| d.as_u64())
                            .filter_map(|d| {
                                ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]
                                    .get(d as usize)
                                    .copied()
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                if !codes.is_empty() {
                    new_schedule["byday"] = serde_json::json!(codes);
                }
            }
            "monthly" => {
                let (h, m) = parse_time("time");
                new_schedule["freq"] = "MONTHLY".into();
                new_schedule["byhour"] = h.into();
                new_schedule["byminute"] = m.into();
                if let Some(day) = schedule.get("day").and_then(|d| d.as_u64()) {
                    new_schedule["bymonthday"] = serde_json::json!([day]);
                }
            }
            _ => {}
        }
        obj.insert("schedule".into(), new_schedule);
    }
}

fn write_store(store: &AutomationStore) -> Result<(), String> {
    let body =
        serde_json::to_string_pretty(store).map_err(|e| format!("serialize automations: {e}"))?;
    write_json(&store_path(), &body)
}

fn read_records() -> RunRecordStore {
    let Ok(content) = std::fs::read_to_string(records_path()) else {
        return RunRecordStore::default();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

const MAX_RECORDS: usize = 500;

fn write_records(store: &mut RunRecordStore) -> Result<(), String> {
    // Cap the table: keep the newest records (by startedAt, stable order).
    if store.records.len() > MAX_RECORDS {
        let drop = store.records.len() - MAX_RECORDS;
        store.records.drain(0..drop);
    }
    let body =
        serde_json::to_string_pretty(store).map_err(|e| format!("serialize records: {e}"))?;
    write_json(&records_path(), &body)
}

/// Append a "running" record and return its id.
fn record_run_started(automation: &Automation, started_at: &str) -> String {
    let _guard = record_access().lock().unwrap();
    let mut records = read_records();
    let id = uuid::Uuid::now_v7().to_string();
    records.records.push(AutomationRunRecord {
        id: id.clone(),
        automation_id: automation.id.clone(),
        automation_name: automation.name.clone(),
        status: "running".into(),
        started_at: started_at.into(),
        finished_at: None,
        session_id: None,
        error: None,
        archived: false,
    });
    let _ = write_records(&mut records);
    id
}

/// Link the newly-created session while the automation is still running.
fn record_run_session(record_id: &str, session_id: &str) {
    let _guard = record_access().lock().unwrap();
    let mut records = read_records();
    for r in &mut records.records {
        if r.id == record_id {
            r.session_id = Some(session_id.into());
        }
    }
    let _ = write_records(&mut records);
}

/// Finalize a record as success/failed. The session was linked at dispatch time.
fn record_run_finished(record_id: &str, ok: bool, session_id: Option<&str>, error: Option<&str>) {
    let _guard = record_access().lock().unwrap();
    let mut records = read_records();
    let now = Local::now().to_rfc3339();
    for r in &mut records.records {
        if r.id == record_id {
            r.status = if ok {
                "success".into()
            } else {
                "failed".into()
            };
            r.finished_at = Some(now.clone());
            r.error = (!ok).then(|| error.unwrap_or("自动化执行失败").to_string());
            if let Some(sid) = session_id {
                r.session_id = Some(sid.into());
            }
        }
    }
    let _ = write_records(&mut records);
}

#[derive(Debug, Clone)]
pub struct AutomationCompletion {
    pub push: bool,
    pub automation_name: String,
}

/// Finalize an automation run when the bridge receives prompt_complete.
/// Returns notification metadata when the session belonged to an automation.
pub fn complete_run_for_session(
    session_id: &str,
    ok: bool,
    error: Option<&str>,
) -> Option<AutomationCompletion> {
    let automation_identity = {
        let _guard = record_access().lock().unwrap();
        let mut records = read_records();
        let mut automation_identity = None;
        let now = Local::now().to_rfc3339();
        for r in &mut records.records {
            if r.status == "running" && r.session_id.as_deref() == Some(session_id) {
                r.status = if ok { "success" } else { "failed" }.into();
                r.finished_at = Some(now.clone());
                r.error = (!ok).then(|| error.unwrap_or("Agent 执行失败").to_string());
                automation_identity = Some((r.automation_id.clone(), r.automation_name.clone()));
            }
        }
        if automation_identity.is_some() {
            let _ = write_records(&mut records);
        }
        automation_identity
    };
    full_access_sessions().lock().unwrap().remove(session_id);
    automation_identity.map(|(id, recorded_name)| {
        let _guard = store_access().lock().unwrap();
        read_store()
            .automations
            .into_iter()
            .find(|a| a.id == id)
            .map(|a| AutomationCompletion {
                push: a.push_to_we_chat,
                automation_name: a.name,
            })
            .unwrap_or(AutomationCompletion {
                push: false,
                automation_name: recorded_name,
            })
    })
}

/// Whether permission requests for this automation session may be approved
/// without changing the user's global permission mode.
pub fn is_full_access_session(session_id: &str) -> bool {
    full_access_sessions().lock().unwrap().contains(session_id)
}

pub fn clear_runtime_sessions() {
    full_access_sessions().lock().unwrap().clear();
}

fn fail_stale_running_records() {
    let _guard = record_access().lock().unwrap();
    let mut records = read_records();
    let now = Local::now().to_rfc3339();
    let mut changed = false;
    for record in &mut records.records {
        if record.status == "running" {
            record.status = "failed".into();
            record.finished_at = Some(now.clone());
            record.error = Some("应用或 Agent 在任务完成前退出".into());
            changed = true;
        }
    }
    if changed {
        let _ = write_records(&mut records);
    }
}

// ---------- scheduling ----------

fn now_local() -> DateTime<Local> {
    Local::now()
}

fn parse_hhmm(s: &str) -> Option<(u32, u32)> {
    let mut parts = s.split(':');
    let h: u32 = parts.next()?.parse().ok()?;
    let m: u32 = parts.next()?.parse().ok()?;
    if parts.next().is_some() || h > 23 || m > 59 {
        return None;
    }
    Some((h, m))
}

fn parse_date(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d").ok()
}

fn at_local(date: NaiveDate, h: u32, m: u32) -> Option<DateTime<Local>> {
    date.and_time(NaiveTime::from_hms_opt(h, m, 0)?)
        .and_local_timezone(Local)
        .single()
}

fn weekday_code(date: NaiveDate) -> &'static str {
    match date.weekday() {
        Weekday::Mon => "MO",
        Weekday::Tue => "TU",
        Weekday::Wed => "WE",
        Weekday::Thu => "TH",
        Weekday::Fri => "FR",
        Weekday::Sat => "SA",
        Weekday::Sun => "SU",
    }
}

/// Monday of the week containing `date` (week-parity anchor for 双周).
fn week_start(date: NaiveDate) -> NaiveDate {
    let offset = date.weekday().num_days_from_monday() as i64;
    date - Duration::days(offset)
}

fn recurring_next(
    sched: &AutomationSchedule,
    anchor: &DateTime<Local>,
    from: DateTime<Local>,
) -> Option<DateTime<Local>> {
    let h = sched.byhour.min(23);
    let m = sched.byminute.min(59);
    match sched.freq {
        ScheduleFreq::DAILY => {
            for i in 0..2 {
                let date = (from + Duration::days(i)).date_naive();
                if let Some(candidate) = at_local(date, h, m) {
                    if candidate > from {
                        return Some(candidate);
                    }
                }
            }
            None
        }
        ScheduleFreq::WEEKLY => {
            let interval = sched.interval.max(1).min(2) as i64;
            let anchor_week = week_start(anchor.date_naive());
            for i in 0..(7 * interval + 7) {
                let date = (from + Duration::days(i)).date_naive();
                if !sched.byday.iter().any(|d| d == weekday_code(date)) {
                    continue;
                }
                if (week_start(date) - anchor_week).num_weeks() % interval != 0 {
                    continue;
                }
                if let Some(candidate) = at_local(date, h, m) {
                    if candidate > from {
                        return Some(candidate);
                    }
                }
            }
            None
        }
        ScheduleFreq::MONTHLY => {
            if sched.bymonthday.is_empty() {
                return None;
            }
            for i in 0..62 {
                let date = (from + Duration::days(i)).date_naive();
                if !sched.bymonthday.contains(&date.day()) {
                    continue;
                }
                if let Some(candidate) = at_local(date, h, m) {
                    if candidate > from {
                        return Some(candidate);
                    }
                }
            }
            None
        }
        ScheduleFreq::YEARLY => {
            let month = *sched.bymonth.first()?;
            let day = *sched.bymonthday.first()?;
            // Search far enough to cover leap-day schedules. An invalid date in
            // one year (for example 02-29 in 2027) must not abort the search.
            for year_offset in 0..=8 {
                let year = from.year() + year_offset;
                let Some(date) = NaiveDate::from_ymd_opt(year, month, day) else {
                    continue;
                };
                if let Some(candidate) = at_local(date, h, m) {
                    if candidate > from {
                        return Some(candidate);
                    }
                }
            }
            None
        }
        ScheduleFreq::HOURLY => {
            // 按间隔: fire at the configured start time + k*intervalHours on
            // selected weekdays. The old midnight anchor silently ignored the
            // time selected in the editor.
            let step = sched.interval_hours.clamp(1, 24);
            let byday = if sched.byday.is_empty() {
                ALL_DAYS.iter().map(|s| s.to_string()).collect::<Vec<_>>()
            } else {
                sched.byday.clone()
            };
            for i in 0..8 {
                let date = (from + Duration::days(i)).date_naive();
                if !byday.iter().any(|d| d == weekday_code(date)) {
                    continue;
                }
                let mut hour = h;
                while hour < 24 {
                    if let Some(candidate) = at_local(date, hour, m) {
                        if candidate > from {
                            return Some(candidate);
                        }
                    }
                    hour += step;
                }
            }
            None
        }
    }
}

/// Compute the next fire time for an automation after `from`, honoring the
/// validity window. Returns an RFC3339 string in local time.
fn compute_next_run(a: &Automation, from: DateTime<Local>) -> Option<String> {
    if a.status != "ACTIVE" {
        return None;
    }
    if a.schedule_type == "once" {
        let date = parse_date(a.scheduled_date.as_deref()?)?;
        let (h, m) = parse_hhmm(a.scheduled_time.as_deref().unwrap_or("09:00"))?;
        let candidate = at_local(date, h, m)?;
        // Fired or missed once-tasks have no upcoming run.
        return (candidate > from).then(|| candidate.to_rfc3339());
    }
    let valid_from = a.valid_from_date.as_deref().and_then(parse_date);
    let valid_until = a.valid_until_date.as_deref().and_then(parse_date);
    if let Some(until) = valid_until {
        if from.date_naive() > until {
            return None; // 已过期
        }
    }
    // Clamp the search start to the validity window's first day.
    let search_from = match valid_from {
        Some(fd) if from.date_naive() < fd => at_local(fd, 0, 0)? - Duration::minutes(1),
        _ => from,
    };
    let anchor = DateTime::parse_from_rfc3339(&a.created_at)
        .map(|dt| dt.with_timezone(&Local))
        .unwrap_or(from);
    let candidate = recurring_next(&a.schedule, &anchor, search_from)?;
    if let Some(until) = valid_until {
        if candidate.date_naive() > until {
            return None;
        }
    }
    Some(candidate.to_rfc3339())
}

fn refresh_next_runs(store: &mut AutomationStore) {
    let now = now_local();
    for a in &mut store.automations {
        a.next_run_at = compute_next_run(a, now);
    }
}

/// Initialize only schedules that do not have a persisted next run. It is
/// essential not to recompute an already-due timestamp before the scheduler
/// gets a chance to claim it.
fn ensure_next_runs(store: &mut AutomationStore, now: DateTime<Local>) {
    for a in &mut store.automations {
        if a.next_run_at.is_none() && a.status == "ACTIVE" {
            a.next_run_at = compute_next_run(a, now);
            let schedule_finished = if a.schedule_type == "once" {
                a.scheduled_date
                    .as_deref()
                    .and_then(parse_date)
                    .and_then(|date| {
                        let (hour, minute) = parse_hhmm(a.scheduled_time.as_deref()?)?;
                        at_local(date, hour, minute)
                    })
                    .is_some_and(|scheduled_at| scheduled_at <= now)
            } else {
                a.valid_until_date
                    .as_deref()
                    .and_then(parse_date)
                    .is_some_and(|until| until < now.date_naive())
            };
            if a.next_run_at.is_none() && schedule_finished {
                a.status = "PAUSED".into();
            }
        }
    }
}

/// Claim all persisted due tasks using a fire-once misfire policy. The next
/// timestamp (or PAUSED for a one-shot task) is persisted before dispatch, so
/// a second tick cannot execute the same occurrence twice.
fn claim_due(store: &mut AutomationStore, now: DateTime<Local>) -> Vec<Automation> {
    ensure_next_runs(store, now);
    let mut due = Vec::new();
    for a in &mut store.automations {
        if a.status != "ACTIVE" {
            continue;
        }
        let is_due = a
            .next_run_at
            .as_ref()
            .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
            .map(|t| t.with_timezone(&Local) <= now)
            .unwrap_or(false);
        if !is_due {
            continue;
        }
        due.push(a.clone());
        a.last_run_at = Some(now.to_rfc3339());
        if a.schedule_type == "once" {
            a.status = "PAUSED".into();
            a.next_run_at = None;
        } else {
            a.next_run_at = compute_next_run(a, now);
            if a.next_run_at.is_none()
                && a.valid_until_date
                    .as_deref()
                    .and_then(parse_date)
                    .is_some_and(|until| until < now.date_naive())
            {
                a.status = "PAUSED".into();
            }
        }
    }
    due
}

fn first_cwd(a: &Automation) -> Option<String> {
    a.cwds
        .split(',')
        .map(|c| c.trim())
        .find(|c| !c.is_empty())
        .map(|c| c.to_string())
}

fn validate_weekdays(days: &[String]) -> Result<(), String> {
    if days.is_empty() {
        return Err("请至少选择一个星期".into());
    }
    if days.iter().any(|d| !ALL_DAYS.contains(&d.as_str())) {
        return Err("执行星期包含无效值".into());
    }
    Ok(())
}

/// Validate the persisted contract at the backend boundary. Frontend
/// validation is useful feedback, but direct IPC calls and migrated files must
/// not be able to create an ACTIVE task that can never produce a next run.
fn validate_automation_at(a: &Automation, now: DateTime<Local>) -> Result<(), String> {
    if a.name.trim().is_empty() {
        return Err("请填写自动化任务名称".into());
    }
    if a.prompt.trim().is_empty() {
        return Err("请填写提示词".into());
    }
    if !matches!(a.status.as_str(), "ACTIVE" | "PAUSED") {
        return Err("自动化任务状态无效".into());
    }
    if !matches!(a.permission_mode.as_str(), "default" | "fullAccess") {
        return Err("自动化权限模式无效".into());
    }
    if !matches!(a.schedule_type.as_str(), "recurring" | "once") {
        return Err("自动化调度类型无效".into());
    }

    if a.schedule_type == "once" {
        let date = a
            .scheduled_date
            .as_deref()
            .and_then(parse_date)
            .ok_or("请选择有效的单次执行日期")?;
        let (hour, minute) = a
            .scheduled_time
            .as_deref()
            .and_then(parse_hhmm)
            .ok_or("请选择有效的单次执行时间")?;
        let candidate = at_local(date, hour, minute).ok_or("单次执行时间在当前时区无效")?;
        if a.status == "ACTIVE" && candidate <= now {
            return Err("单次执行时间必须晚于当前时间".into());
        }
        return Ok(());
    }

    if a.schedule.byhour > 23 || a.schedule.byminute > 59 {
        return Err("执行时间无效".into());
    }
    match a.schedule.freq {
        ScheduleFreq::DAILY => {}
        ScheduleFreq::WEEKLY => {
            validate_weekdays(&a.schedule.byday)?;
            if !(1..=2).contains(&a.schedule.interval) {
                return Err("每周执行间隔只能是 1 或 2 周".into());
            }
        }
        ScheduleFreq::MONTHLY => {
            if a.schedule.bymonthday.is_empty()
                || a.schedule.bymonthday.iter().any(|d| !(1..=31).contains(d))
            {
                return Err("请选择有效的每月执行日期".into());
            }
        }
        ScheduleFreq::YEARLY => {
            if a.schedule.bymonth.len() != 1
                || a.schedule.bymonthday.len() != 1
                || !(1..=12).contains(&a.schedule.bymonth[0])
                || !(1..=31).contains(&a.schedule.bymonthday[0])
                || !(2000..=2007).any(|year| {
                    NaiveDate::from_ymd_opt(year, a.schedule.bymonth[0], a.schedule.bymonthday[0])
                        .is_some()
                })
            {
                return Err("请选择有效的年度执行日期".into());
            }
        }
        ScheduleFreq::HOURLY => {
            validate_weekdays(&a.schedule.byday)?;
            if !(1..=24).contains(&a.schedule.interval_hours) {
                return Err("按间隔执行需设置为 1 至 24 小时".into());
            }
        }
    }

    let valid_from = match a.valid_from_date.as_deref() {
        Some(raw) => Some(parse_date(raw).ok_or("生效开始日期无效")?),
        None => None,
    };
    let valid_until = match a.valid_until_date.as_deref() {
        Some(raw) => Some(parse_date(raw).ok_or("生效结束日期无效")?),
        None => None,
    };
    if let (Some(from), Some(until)) = (valid_from, valid_until) {
        if from > until {
            return Err("生效开始日期不能晚于结束日期".into());
        }
    }
    if a.status == "ACTIVE" && valid_until.is_some_and(|until| until < now.date_naive()) {
        return Err("生效日期区间已过期，请更新结束日期".into());
    }
    Ok(())
}

// ---------- Tauri commands ----------

/// Full snapshot: automations (with recomputed next runs) + run records.
#[tauri::command]
pub fn automations_snapshot(app: AppHandle) -> AutomationSnapshot {
    // Never hold both file-store locks: prompt completion acquires records
    // before looking up its automation, so nested locking here could deadlock.
    let automations = {
        let _guard = store_access().lock().unwrap();
        let mut store = read_store();
        ensure_next_runs(&mut store, now_local());
        let _ = write_store(&store);
        store.automations
    };
    let records = {
        let _guard = record_access().lock().unwrap();
        read_records().records
    };
    sync_autostart_enabled(
        &app,
        automations
            .iter()
            .any(|automation| automation.status == "ACTIVE"),
    );
    AutomationSnapshot {
        automations,
        records,
    }
}

/// Treat empty strings as absent for optional fields.
fn blank_to_none(value: &mut Option<String>) {
    if value.as_deref().map(str::trim) == Some("") {
        *value = None;
    }
}

#[tauri::command]
pub fn automations_save(app: AppHandle, automation: Automation) -> Result<Automation, String> {
    crate::policy::require_feature("automations")?;
    if let Some(model_id) = automation.model_id.as_deref() {
        crate::policy::require_model(model_id)?;
    }
    let _guard = store_access().lock().unwrap();
    let mut store = read_store();
    let id = if automation.id.is_empty() {
        uuid::Uuid::now_v7().to_string()
    } else {
        automation.id.clone()
    };
    let now = now_local().to_rfc3339();
    let mut final_automation = automation;
    final_automation.id = id.clone();
    if final_automation.created_at.is_empty() {
        final_automation.created_at = now;
    }
    final_automation.status = final_automation.status.to_uppercase();
    // Frontend sends "" for unset optionals; normalize to None.
    blank_to_none(&mut final_automation.model_id);
    blank_to_none(&mut final_automation.expert_id);
    blank_to_none(&mut final_automation.expert_name);
    blank_to_none(&mut final_automation.scheduled_date);
    blank_to_none(&mut final_automation.scheduled_time);
    blank_to_none(&mut final_automation.valid_from_date);
    blank_to_none(&mut final_automation.valid_until_date);
    final_automation.name = final_automation.name.trim().to_string();
    final_automation.prompt = final_automation.prompt.trim().to_string();
    final_automation.skills.sort();
    final_automation.skills.dedup();
    final_automation.connector_ids.sort();
    final_automation.connector_ids.dedup();
    validate_automation_at(&final_automation, now_local())?;
    final_automation.next_run_at = compute_next_run(&final_automation, now_local());

    if let Some(existing) = store.automations.iter_mut().find(|a| a.id == id) {
        *existing = final_automation.clone();
    } else {
        store.automations.push(final_automation.clone());
    }
    write_store(&store)?;
    let has_active = store
        .automations
        .iter()
        .any(|automation| automation.status == "ACTIVE");
    drop(_guard);
    sync_autostart_enabled(&app, has_active);
    Ok(final_automation)
}

#[tauri::command]
pub fn automations_delete(app: AppHandle, id: String) -> Result<(), String> {
    crate::policy::require_feature("automations")?;
    let _guard = store_access().lock().unwrap();
    let mut store = read_store();
    if !store
        .automations
        .iter()
        .any(|automation| automation.id == id)
    {
        return Err(format!("automation {id} not found"));
    }
    store.automations.retain(|a| a.id != id);
    write_store(&store)?;
    let has_active = store
        .automations
        .iter()
        .any(|automation| automation.status == "ACTIVE");
    drop(_guard);
    sync_autostart_enabled(&app, has_active);
    Ok(())
}

#[tauri::command]
pub fn automations_set_status(app: AppHandle, id: String, status: String) -> Result<(), String> {
    crate::policy::require_feature("automations")?;
    let _guard = store_access().lock().unwrap();
    let normalized_status = status.to_uppercase();
    let normalized = match normalized_status.as_str() {
        "ACTIVE" => "ACTIVE",
        "PAUSED" => "PAUSED",
        _ => return Err("自动化任务状态无效".into()),
    };
    let mut store = read_store();
    let automation = store
        .automations
        .iter_mut()
        .find(|a| a.id == id)
        .ok_or_else(|| format!("automation {id} not found"))?;
    automation.status = normalized.into();
    if normalized == "ACTIVE" {
        validate_automation_at(automation, now_local())?;
    }
    refresh_next_runs(&mut store);
    write_store(&store)?;
    let has_active = store
        .automations
        .iter()
        .any(|automation| automation.status == "ACTIVE");
    drop(_guard);
    sync_autostart_enabled(&app, has_active);
    Ok(())
}

/// Manually fire an automation now (test run). Opens a new EchoAgent session and
/// sends the prompt — the result appears in the sidebar like any chat, and a
/// run record is written for the 运行记录 tab.
#[tauri::command]
pub async fn automations_run(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    crate::policy::require_feature("automations")?;
    let automation = {
        let _guard = store_access().lock().unwrap();
        read_store()
            .automations
            .into_iter()
            .find(|a| a.id == id)
            .ok_or_else(|| format!("automation {id} not found"))?
    };
    let cwd = first_cwd(&automation).unwrap_or_else(|| {
        state
            .cwd
            .lock()
            .unwrap()
            .clone()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default()
    });
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;

    let started = now_local().to_rfc3339();
    let record_id = record_run_started(&automation, &started);
    let result = run_automation_once(&tx, &automation, &PathBuf::from(&cwd), &record_id).await;
    if let Err(error) = &result {
        record_run_finished(&record_id, false, None, Some(error));
        notify_run_failure(&app, &automation, error).await;
    }
    result?;

    // Mark last-run.
    {
        let _guard = store_access().lock().unwrap();
        let mut store = read_store();
        for a in &mut store.automations {
            if a.id == id {
                a.last_run_at = Some(started.clone());
            }
        }
        write_store(&store)?;
    }
    Ok(())
}

async fn notify_run_failure(app: &AppHandle, automation: &Automation, error: &str) {
    let body = format!("{}：{}", automation.name, error);
    crate::notifications::append(
        crate::notifications::NotificationKind::Error,
        "自动化任务执行失败",
        Some(&body),
        None,
        "error",
    );
    if automation.push_to_we_chat {
        let _ = crate::notifications::dispatch_automation(
            app,
            crate::notifications::NotifyMessage {
                title: format!("自动化失败：{}", automation.name),
                body: Some(error.to_string()),
                level: "error".into(),
                session_id: None,
            },
        )
        .await;
    }
}

/// Open a fresh EchoAgent session and send the automation prompt.
/// Returns the new session id on success.
async fn run_automation_once(
    tx: &xai_acp_lib::AcpAgentTx,
    automation: &Automation,
    cwd: &PathBuf,
    record_id: &str,
) -> Result<String, String> {
    crate::policy::require_feature("automations")?;
    if let Some(model_id) = automation.model_id.as_deref() {
        crate::policy::require_model(model_id)?;
    }
    if !cwd.is_dir() {
        return Err(format!("自动化工作空间不存在：{}", cwd.display()));
    }
    let context = resolve_execution_context(tx, automation, cwd).await?;
    let reasoning_effort = automation.model_is_thinking.then_some("high");
    let session_id = crate::agent_runtime::new_session_with_options(
        tx,
        cwd,
        automation.model_id.as_deref(),
        reasoning_effort,
    )
    .await
    .map_err(|e| e.to_string())?;
    record_run_session(record_id, &session_id);
    if automation.permission_mode == "fullAccess" {
        full_access_sessions()
            .lock()
            .unwrap()
            .insert(session_id.clone());
    }
    if let (Some(expert_id), Some(expert_name)) = (&automation.expert_id, &automation.expert_name) {
        let _ = crate::meta::set_expert(
            &session_id,
            crate::meta::ExpertBinding {
                expert_id: expert_id.clone(),
                expert_name: expert_name.clone(),
                source: "automation".into(),
                avatar_local: None,
            },
        );
    }
    let prompt = automation_prompt(automation, &context);
    crate::agent_runtime::prompt(tx, &session_id, &prompt)
        .await
        .map_err(|e| {
            full_access_sessions().lock().unwrap().remove(&session_id);
            e.to_string()
        })?;
    Ok(session_id)
}

#[derive(Debug, Default)]
struct AutomationExecutionContext {
    expert_prompt: Option<String>,
    skills: Vec<(String, String, String)>,
    connectors: Vec<String>,
}

async fn resolve_execution_context(
    tx: &xai_acp_lib::AcpAgentTx,
    automation: &Automation,
    cwd: &PathBuf,
) -> Result<AutomationExecutionContext, String> {
    let mut context = AutomationExecutionContext::default();

    if let Some(expert_name) = automation
        .expert_name
        .as_deref()
        .or(automation.expert_id.as_deref())
    {
        context.expert_prompt = Some(
            crate::agents_store::resolve_agent_prompt(
                expert_name,
                Some(cwd.to_string_lossy().into_owned()),
            )
            .ok_or_else(|| format!("所选专家不存在或没有有效角色定义：{expert_name}"))?,
        );
    }

    if !automation.skills.is_empty() {
        let catalog =
            crate::skills::skills_list_with_tx(tx, Some(cwd.to_string_lossy().into_owned()))
                .await?;
        for selected in &automation.skills {
            let skill = catalog
                .iter()
                .find(|skill| skill.name == *selected)
                .ok_or_else(|| format!("所选技能不存在：{selected}"))?;
            if !skill.enabled {
                return Err(format!("所选技能未启用：{selected}"));
            }
            let configured_path = skill
                .path
                .as_deref()
                .ok_or_else(|| format!("所选技能缺少本地指令路径：{selected}"))?;
            let mut skill_path = PathBuf::from(configured_path);
            if skill_path.is_dir() {
                skill_path = skill_path.join("SKILL.md");
            }
            let raw = std::fs::read_to_string(&skill_path).map_err(|e| {
                format!(
                    "读取技能 {selected} 的指令失败（{}）：{e}",
                    skill_path.display()
                )
            })?;
            let body = crate::agents_store::markdown_body(&raw);
            if body.is_empty() {
                return Err(format!("所选技能没有可执行指令：{selected}"));
            }
            context.skills.push((
                selected.clone(),
                skill_path.to_string_lossy().into_owned(),
                body,
            ));
        }
    }

    if !automation.connector_ids.is_empty() {
        let connectors = crate::mcp::mcp_list_with_tx(tx, None).await?;
        for selected in &automation.connector_ids {
            let connector = connectors
                .iter()
                .find(|connector| connector.name == *selected)
                .ok_or_else(|| format!("所选连接器未配置：{selected}"))?;
            if !connector.enabled {
                return Err(format!("所选连接器未启用：{selected}"));
            }
            context.connectors.push(connector.name.clone());
        }
    }

    Ok(context)
}

fn automation_prompt(automation: &Automation, resolved: &AutomationExecutionContext) -> String {
    let mut context = Vec::new();
    if let Some(expert_prompt) = &resolved.expert_prompt {
        let expert_name = automation.expert_name.as_deref().unwrap_or("所选专家");
        context.push(format!(
            "<automation-expert name=\"{expert_name}\">\n{expert_prompt}\n</automation-expert>\n必须严格按照以上专家角色定义执行。"
        ));
    }
    for (name, path, body) in &resolved.skills {
        context.push(format!(
            "<automation-skill name=\"{name}\" path=\"{path}\">\n{body}\n</automation-skill>\n这是用户明确选择的技能，必须遵循其中的执行流程。"
        ));
    }
    if !resolved.connectors.is_empty() {
        context.push(format!(
            "以下 MCP 连接器已经过运行前检查并处于启用状态；需要外部能力时优先使用：{}。",
            resolved.connectors.join("、")
        ));
    }
    if context.is_empty() {
        automation.prompt.clone()
    } else {
        format!(
            "[自动化执行上下文]\n{}\n\n[自动化任务]\n{}",
            context.join("\n"),
            automation.prompt
        )
    }
}

#[tauri::command]
pub fn automation_records_archive(id: String, archived: bool) -> Result<(), String> {
    crate::policy::require_feature("automations")?;
    let _guard = record_access().lock().unwrap();
    let mut records = read_records();
    let record = records
        .records
        .iter_mut()
        .find(|record| record.id == id)
        .ok_or_else(|| format!("automation record {id} not found"))?;
    record.archived = archived;
    write_records(&mut records)
}

#[tauri::command]
pub fn automation_records_delete(id: String) -> Result<(), String> {
    crate::policy::require_feature("automations")?;
    let _guard = record_access().lock().unwrap();
    let mut records = read_records();
    if !records.records.iter().any(|record| record.id == id) {
        return Err(format!("automation record {id} not found"));
    }
    records.records.retain(|r| r.id != id);
    write_records(&mut records)
}

// ---------- background scheduler ----------

/// Scheduler tick. Fires any automation whose `next_run_at` has passed.
pub async fn scheduler_tick(app: &AppHandle, tx: &xai_acp_lib::AcpAgentTx, default_cwd: &PathBuf) {
    let now = now_local();
    let (due, active_state_changed, has_active) = {
        let _guard = store_access().lock().unwrap();
        let mut store = read_store();
        let had_active = store
            .automations
            .iter()
            .any(|automation| automation.status == "ACTIVE");
        let due = claim_due(&mut store, now);
        let _ = write_store(&store);
        let has_active = store
            .automations
            .iter()
            .any(|automation| automation.status == "ACTIVE");
        (due, had_active != has_active, has_active)
    };
    if active_state_changed {
        sync_autostart_enabled(app, has_active);
    }
    for automation in &due {
        let cwd = first_cwd(automation)
            .map(PathBuf::from)
            .unwrap_or_else(|| default_cwd.clone());
        let started = now.to_rfc3339();
        let record_id = record_run_started(automation, &started);
        match run_automation_once(tx, automation, &cwd, &record_id).await {
            Ok(_) => {}
            Err(e) => {
                tracing::warn!(error = ?e, id = %automation.id, "automation fire failed");
                record_run_finished(&record_id, false, None, Some(&e));
                notify_run_failure(app, automation, &e).await;
            }
        }
    }
}

/// Start a scheduler bound to one runtime. The caller owns and replaces the
/// returned handle when the runtime restarts.
pub fn start_scheduler(
    app: AppHandle,
    tx: xai_acp_lib::AcpAgentTx,
    default_cwd: PathBuf,
) -> tokio::task::JoinHandle<()> {
    fail_stale_running_records();
    tokio::spawn(async move {
        // Tick every 60s. The first tick is immediate so newly-due tasks fire
        // quickly after app start.
        loop {
            scheduler_tick(&app, &tx, &default_cwd).await;
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        }
    })
}

// ---------- unit tests ----------

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    /// Helper: build a local DateTime from components.
    fn local(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Local> {
        Local
            .with_ymd_and_hms(y, mo, d, h, mi, 0)
            .single()
            .expect("valid local datetime")
    }

    fn date(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    // --- parse_hhmm ---

    #[test]
    fn parse_hhmm_valid() {
        assert_eq!(parse_hhmm("09:30"), Some((9, 30)));
        assert_eq!(parse_hhmm("00:00"), Some((0, 0)));
        assert_eq!(parse_hhmm("23:59"), Some((23, 59)));
    }

    #[test]
    fn parse_hhmm_invalid() {
        assert_eq!(parse_hhmm("24:00"), None);
        assert_eq!(parse_hhmm("12:60"), None);
        assert_eq!(parse_hhmm("12:30:00"), None);
        assert_eq!(parse_hhmm("abc"), None);
        assert_eq!(parse_hhmm(""), None);
        assert_eq!(parse_hhmm("12"), None);
    }

    // --- parse_date ---

    #[test]
    fn parse_date_valid() {
        assert_eq!(parse_date("2026-07-01"), Some(date(2026, 7, 1)));
        assert_eq!(parse_date(" 2026-01-15 "), Some(date(2026, 1, 15)));
    }

    #[test]
    fn parse_date_invalid() {
        assert_eq!(parse_date("not-a-date"), None);
        assert_eq!(parse_date("2026-13-01"), None);
        assert_eq!(parse_date(""), None);
    }

    // --- weekday_code ---

    #[test]
    fn weekday_code_all_days() {
        // 2026-07-06 is Monday
        assert_eq!(weekday_code(date(2026, 7, 6)), "MO");
        assert_eq!(weekday_code(date(2026, 7, 7)), "TU");
        assert_eq!(weekday_code(date(2026, 7, 8)), "WE");
        assert_eq!(weekday_code(date(2026, 7, 9)), "TH");
        assert_eq!(weekday_code(date(2026, 7, 10)), "FR");
        assert_eq!(weekday_code(date(2026, 7, 11)), "SA");
        assert_eq!(weekday_code(date(2026, 7, 12)), "SU");
    }

    // --- week_start ---

    #[test]
    fn week_start_returns_monday() {
        // Wednesday 2026-07-08 → Monday 2026-07-06
        assert_eq!(week_start(date(2026, 7, 8)), date(2026, 7, 6));
        // Monday itself
        assert_eq!(week_start(date(2026, 7, 6)), date(2026, 7, 6));
        // Sunday 2026-07-12 → Monday 2026-07-06
        assert_eq!(week_start(date(2026, 7, 12)), date(2026, 7, 6));
    }

    // --- recurring_next: DAILY ---

    #[test]
    fn daily_next_same_day_future() {
        let sched = AutomationSchedule {
            freq: ScheduleFreq::DAILY,
            byhour: 14,
            byminute: 0,
            ..Default::default()
        };
        let anchor = local(2026, 7, 1, 9, 0);
        let from = local(2026, 7, 6, 10, 0); // before 14:00
        let next = recurring_next(&sched, &anchor, from).unwrap();
        assert_eq!(next, local(2026, 7, 6, 14, 0));
    }

    #[test]
    fn daily_next_rolls_to_tomorrow() {
        let sched = AutomationSchedule {
            freq: ScheduleFreq::DAILY,
            byhour: 9,
            byminute: 0,
            ..Default::default()
        };
        let anchor = local(2026, 7, 1, 9, 0);
        let from = local(2026, 7, 6, 10, 0); // after 09:00
        let next = recurring_next(&sched, &anchor, from).unwrap();
        assert_eq!(next, local(2026, 7, 7, 9, 0));
    }

    // --- recurring_next: WEEKLY ---

    #[test]
    fn weekly_next_matching_day() {
        let sched = AutomationSchedule {
            freq: ScheduleFreq::WEEKLY,
            interval: 1,
            byday: vec!["WE".into()],
            byhour: 10,
            byminute: 0,
            ..Default::default()
        };
        let anchor = local(2026, 7, 6, 9, 0); // Monday
        let from = local(2026, 7, 6, 12, 0); // Monday noon
        let next = recurring_next(&sched, &anchor, from).unwrap();
        // Next Wednesday = 2026-07-08
        assert_eq!(next, local(2026, 7, 8, 10, 0));
    }

    #[test]
    fn weekly_biweek_skips_alternate_weeks() {
        let sched = AutomationSchedule {
            freq: ScheduleFreq::WEEKLY,
            interval: 2,
            byday: vec!["MO".into()],
            byhour: 9,
            byminute: 0,
            ..Default::default()
        };
        // Anchor week starts Mon 2026-07-06.
        let anchor = local(2026, 7, 6, 9, 0);
        // From Monday 2026-07-13 (next week, odd offset from anchor week).
        let from = local(2026, 7, 13, 10, 0);
        let next = recurring_next(&sched, &anchor, from).unwrap();
        // Should skip to Mon 2026-07-20 (even weeks from anchor).
        assert_eq!(next, local(2026, 7, 20, 9, 0));
    }

    // --- recurring_next: MONTHLY ---

    #[test]
    fn monthly_next_matching_day() {
        let sched = AutomationSchedule {
            freq: ScheduleFreq::MONTHLY,
            bymonthday: vec![15],
            byhour: 8,
            byminute: 30,
            ..Default::default()
        };
        let anchor = local(2026, 7, 1, 9, 0);
        let from = local(2026, 7, 10, 12, 0);
        let next = recurring_next(&sched, &anchor, from).unwrap();
        assert_eq!(next, local(2026, 7, 15, 8, 30));
    }

    #[test]
    fn monthly_rolls_to_next_month() {
        let sched = AutomationSchedule {
            freq: ScheduleFreq::MONTHLY,
            bymonthday: vec![5],
            byhour: 9,
            byminute: 0,
            ..Default::default()
        };
        let anchor = local(2026, 7, 1, 9, 0);
        let from = local(2026, 7, 10, 12, 0); // past the 5th
        let next = recurring_next(&sched, &anchor, from).unwrap();
        assert_eq!(next, local(2026, 8, 5, 9, 0));
    }

    #[test]
    fn monthly_empty_bymonthday_returns_none() {
        let sched = AutomationSchedule {
            freq: ScheduleFreq::MONTHLY,
            bymonthday: vec![],
            ..Default::default()
        };
        let anchor = local(2026, 7, 1, 9, 0);
        let from = local(2026, 7, 10, 12, 0);
        assert!(recurring_next(&sched, &anchor, from).is_none());
    }

    // --- recurring_next: YEARLY ---

    #[test]
    fn yearly_next_this_year() {
        let sched = AutomationSchedule {
            freq: ScheduleFreq::YEARLY,
            bymonth: vec![12],
            bymonthday: vec![25],
            byhour: 10,
            byminute: 0,
            ..Default::default()
        };
        let anchor = local(2026, 1, 1, 9, 0);
        let from = local(2026, 7, 1, 12, 0);
        let next = recurring_next(&sched, &anchor, from).unwrap();
        assert_eq!(next, local(2026, 12, 25, 10, 0));
    }

    #[test]
    fn yearly_rolls_to_next_year() {
        let sched = AutomationSchedule {
            freq: ScheduleFreq::YEARLY,
            bymonth: vec![3],
            bymonthday: vec![1],
            byhour: 9,
            byminute: 0,
            ..Default::default()
        };
        let anchor = local(2026, 1, 1, 9, 0);
        let from = local(2026, 7, 1, 12, 0); // past March
        let next = recurring_next(&sched, &anchor, from).unwrap();
        assert_eq!(next, local(2027, 3, 1, 9, 0));
    }

    #[test]
    fn yearly_leap_day_skips_non_leap_years() {
        let sched = AutomationSchedule {
            freq: ScheduleFreq::YEARLY,
            bymonth: vec![2],
            bymonthday: vec![29],
            byhour: 8,
            byminute: 15,
            ..Default::default()
        };
        let anchor = local(2026, 1, 1, 9, 0);
        let from = local(2027, 3, 1, 12, 0);
        let next = recurring_next(&sched, &anchor, from).unwrap();
        assert_eq!(next, local(2028, 2, 29, 8, 15));
    }

    // --- recurring_next: HOURLY ---

    #[test]
    fn hourly_next_within_day() {
        let sched = AutomationSchedule {
            freq: ScheduleFreq::HOURLY,
            interval_hours: 3,
            byday: ALL_DAYS.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        };
        let anchor = local(2026, 7, 6, 0, 0);
        let from = local(2026, 7, 6, 7, 30); // between 06:00 and 09:00
        let next = recurring_next(&sched, &anchor, from).unwrap();
        assert_eq!(next, local(2026, 7, 6, 9, 0));
    }

    #[test]
    fn hourly_respects_configured_start_and_minute() {
        let sched = AutomationSchedule {
            freq: ScheduleFreq::HOURLY,
            interval_hours: 3,
            byday: ALL_DAYS.iter().map(|s| s.to_string()).collect(),
            byhour: 9,
            byminute: 30,
            ..Default::default()
        };
        let anchor = local(2026, 7, 6, 0, 0);
        let from = local(2026, 7, 6, 10, 0);
        let next = recurring_next(&sched, &anchor, from).unwrap();
        assert_eq!(next, local(2026, 7, 6, 12, 30));
    }

    // --- compute_next_run ---

    #[test]
    fn compute_next_run_paused_returns_none() {
        let a = Automation {
            id: "1".into(),
            name: "test".into(),
            prompt: "p".into(),
            status: "PAUSED".into(),
            created_at: "2026-01-01T00:00:00+08:00".into(),
            ..test_automation()
        };
        assert!(compute_next_run(&a, local(2026, 7, 6, 10, 0)).is_none());
    }

    #[test]
    fn compute_next_run_once_future() {
        let a = Automation {
            id: "1".into(),
            name: "once".into(),
            prompt: "p".into(),
            schedule_type: "once".into(),
            scheduled_date: Some("2026-12-25".into()),
            scheduled_time: Some("10:00".into()),
            created_at: "2026-01-01T00:00:00+08:00".into(),
            ..test_automation()
        };
        let result = compute_next_run(&a, local(2026, 7, 6, 10, 0));
        assert!(result.is_some());
    }

    #[test]
    fn compute_next_run_once_past_returns_none() {
        let a = Automation {
            id: "1".into(),
            name: "once".into(),
            prompt: "p".into(),
            schedule_type: "once".into(),
            scheduled_date: Some("2020-01-01".into()),
            scheduled_time: Some("10:00".into()),
            created_at: "2020-01-01T00:00:00+08:00".into(),
            ..test_automation()
        };
        assert!(compute_next_run(&a, local(2026, 7, 6, 10, 0)).is_none());
    }

    #[test]
    fn compute_next_run_expired_validity_returns_none() {
        let a = Automation {
            id: "1".into(),
            name: "expired".into(),
            prompt: "p".into(),
            valid_until_date: Some("2026-06-30".into()),
            created_at: "2026-01-01T00:00:00+08:00".into(),
            ..test_automation()
        };
        // from is after valid_until
        assert!(compute_next_run(&a, local(2026, 7, 6, 10, 0)).is_none());
    }

    #[test]
    fn claim_due_preserves_future_and_advances_due_recurring() {
        let now = local(2026, 7, 6, 10, 0);
        let mut due = Automation {
            id: "due".into(),
            name: "due".into(),
            prompt: "run".into(),
            next_run_at: Some(local(2026, 7, 6, 9, 0).to_rfc3339()),
            schedule: AutomationSchedule {
                freq: ScheduleFreq::DAILY,
                byhour: 9,
                byminute: 0,
                ..Default::default()
            },
            created_at: local(2026, 1, 1, 9, 0).to_rfc3339(),
            ..test_automation()
        };
        let future = Automation {
            id: "future".into(),
            name: "future".into(),
            prompt: "later".into(),
            next_run_at: Some(local(2026, 7, 6, 11, 0).to_rfc3339()),
            created_at: local(2026, 1, 1, 9, 0).to_rfc3339(),
            ..test_automation()
        };
        let mut store = AutomationStore {
            automations: vec![due.clone(), future],
        };
        let claimed = claim_due(&mut store, now);
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].id, "due");
        due.next_run_at = Some(local(2026, 7, 7, 9, 0).to_rfc3339());
        assert_eq!(store.automations[0].next_run_at, due.next_run_at);
        assert_eq!(
            store.automations[1].next_run_at,
            Some(local(2026, 7, 6, 11, 0).to_rfc3339())
        );
    }

    #[test]
    fn claim_due_pauses_once_task_and_cannot_claim_twice() {
        let now = local(2026, 7, 6, 10, 0);
        let once = Automation {
            id: "once".into(),
            name: "once".into(),
            prompt: "run".into(),
            schedule_type: "once".into(),
            scheduled_date: Some("2026-07-06".into()),
            scheduled_time: Some("09:00".into()),
            next_run_at: Some(local(2026, 7, 6, 9, 0).to_rfc3339()),
            created_at: local(2026, 1, 1, 9, 0).to_rfc3339(),
            ..test_automation()
        };
        let mut store = AutomationStore {
            automations: vec![once],
        };
        assert_eq!(claim_due(&mut store, now).len(), 1);
        assert_eq!(store.automations[0].status, "PAUSED");
        assert!(store.automations[0].next_run_at.is_none());
        assert!(claim_due(&mut store, now + Duration::minutes(1)).is_empty());
    }

    #[test]
    fn ensure_next_runs_pauses_finished_active_schedules() {
        let now = local(2026, 7, 6, 10, 0);
        let expired_recurring = Automation {
            id: "expired".into(),
            name: "expired".into(),
            prompt: "run".into(),
            valid_until_date: Some("2026-06-30".into()),
            next_run_at: None,
            ..test_automation()
        };
        let missed_once = Automation {
            id: "once".into(),
            name: "once".into(),
            prompt: "run".into(),
            schedule_type: "once".into(),
            scheduled_date: Some("2026-07-05".into()),
            scheduled_time: Some("09:00".into()),
            next_run_at: None,
            ..test_automation()
        };
        let mut store = AutomationStore {
            automations: vec![expired_recurring, missed_once],
        };

        ensure_next_runs(&mut store, now);

        assert!(store
            .automations
            .iter()
            .all(|automation| automation.status == "PAUSED"));
    }

    // --- first_cwd ---

    #[test]
    fn first_cwd_extracts_first_entry() {
        let a = Automation {
            cwds: "/home/user, /tmp".into(),
            ..test_automation()
        };
        assert_eq!(first_cwd(&a), Some("/home/user".into()));
    }

    #[test]
    fn first_cwd_empty_returns_none() {
        let a = Automation {
            cwds: "".into(),
            ..test_automation()
        };
        assert_eq!(first_cwd(&a), None);
    }

    // --- blank_to_none ---

    #[test]
    fn blank_to_none_normalizes() {
        let mut v = Some("  ".to_string());
        blank_to_none(&mut v);
        assert_eq!(v, None);

        let mut v2 = Some("hello".to_string());
        blank_to_none(&mut v2);
        assert_eq!(v2, Some("hello".into()));

        let mut v3: Option<String> = None;
        blank_to_none(&mut v3);
        assert_eq!(v3, None);
    }

    #[test]
    fn validation_rejects_expired_active_window() {
        let automation = Automation {
            name: "expired".into(),
            prompt: "run".into(),
            valid_until_date: Some("2026-06-30".into()),
            ..test_automation()
        };
        assert_eq!(
            validate_automation_at(&automation, local(2026, 7, 6, 10, 0)),
            Err("生效日期区间已过期，请更新结束日期".into())
        );
    }

    #[test]
    fn validation_allows_editing_finished_paused_once_task() {
        let automation = Automation {
            name: "finished".into(),
            prompt: "run".into(),
            status: "PAUSED".into(),
            schedule_type: "once".into(),
            scheduled_date: Some("2026-07-05".into()),
            scheduled_time: Some("09:00".into()),
            ..test_automation()
        };
        assert!(validate_automation_at(&automation, local(2026, 7, 6, 10, 0)).is_ok());
    }

    #[test]
    fn validation_accepts_valid_leap_day_schedule() {
        let automation = Automation {
            name: "leap".into(),
            prompt: "run".into(),
            schedule: AutomationSchedule {
                freq: ScheduleFreq::YEARLY,
                bymonth: vec![2],
                bymonthday: vec![29],
                ..Default::default()
            },
            ..test_automation()
        };
        assert!(validate_automation_at(&automation, local(2026, 7, 6, 10, 0)).is_ok());
    }

    // --- migrate_legacy_json ---

    #[test]
    fn migrate_legacy_daily() {
        let mut json = serde_json::json!({
            "automations": [{
                "id": "1",
                "name": "old",
                "prompt": "p",
                "status": "active",
                "cwd": "/home",
                "createdAt": "2025-01-01T00:00:00+08:00",
                "schedule": { "type": "daily", "time": "08:30" }
            }]
        });
        migrate_legacy_json(&mut json);
        let item = &json["automations"][0];
        assert_eq!(item["status"], "ACTIVE");
        assert_eq!(item["cwds"], "/home");
        assert_eq!(item["schedule"]["freq"], "DAILY");
        assert_eq!(item["schedule"]["byhour"], 8);
        assert_eq!(item["schedule"]["byminute"], 30);
    }

    #[test]
    fn migrate_legacy_weekly_with_weekdays() {
        let mut json = serde_json::json!({
            "automations": [{
                "id": "2",
                "name": "weekly",
                "prompt": "p",
                "status": "paused",
                "createdAt": "2025-01-01T00:00:00+08:00",
                "schedule": { "type": "weekly", "time": "17:00", "weekdays": [1, 5] }
            }]
        });
        migrate_legacy_json(&mut json);
        let sched = &json["automations"][0]["schedule"];
        assert_eq!(sched["freq"], "WEEKLY");
        // 1=MO, 5=FR in the legacy 0=Sunday mapping
        let byday = sched["byday"].as_array().unwrap();
        assert!(byday.contains(&serde_json::json!("MO")));
        assert!(byday.contains(&serde_json::json!("FR")));
    }

    #[test]
    fn migrate_legacy_already_current_is_noop() {
        let mut json = serde_json::json!({
            "automations": [{
                "id": "3",
                "name": "current",
                "prompt": "p",
                "status": "ACTIVE",
                "createdAt": "2025-01-01T00:00:00+08:00",
                "schedule": { "freq": "DAILY", "interval": 1, "byday": ["MO"], "byhour": 9, "byminute": 0 }
            }]
        });
        let before = json.clone();
        migrate_legacy_json(&mut json);
        // schedule.freq already present → no change to schedule
        assert_eq!(
            json["automations"][0]["schedule"],
            before["automations"][0]["schedule"]
        );
    }

    // --- helper ---

    fn test_automation() -> Automation {
        Automation {
            id: String::new(),
            name: String::new(),
            prompt: String::new(),
            cwds: String::new(),
            status: "ACTIVE".into(),
            model_id: None,
            model_is_thinking: false,
            skills: vec![],
            expert_id: None,
            expert_name: None,
            connector_ids: vec![],
            permission_mode: "fullAccess".into(),
            schedule_type: "recurring".into(),
            schedule: AutomationSchedule::default(),
            scheduled_date: None,
            scheduled_time: None,
            valid_from_date: None,
            valid_until_date: None,
            push_to_we_chat: false,
            last_run_at: None,
            next_run_at: None,
            created_at: String::new(),
        }
    }
}
