use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const DESKTOP_PREFERENCES_FILE: &str = "desktop-preferences.json";
const MAX_DESKTOP_PREFERENCES_BYTES: u64 = 16 * 1024;
static DESKTOP_PREFERENCES_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn preferences_lock() -> &'static Mutex<()> {
    DESKTOP_PREFERENCES_LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct DesktopPreferences {
    pub close_to_tray: bool,
    pub(crate) show_notification_task_title: bool,
    background_notice_shown: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopPreferencesView {
    close_to_tray: bool,
    show_notification_task_title: bool,
}

impl From<&DesktopPreferences> for DesktopPreferencesView {
    fn from(preferences: &DesktopPreferences) -> Self {
        Self {
            close_to_tray: preferences.close_to_tray,
            show_notification_task_title: preferences.show_notification_task_title,
        }
    }
}

impl Default for DesktopPreferences {
    fn default() -> Self {
        Self {
            close_to_tray: true,
            show_notification_task_title: false,
            background_notice_shown: false,
        }
    }
}

fn preferences_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(DESKTOP_PREFERENCES_FILE))
        .map_err(|error| format!("无法定位桌面偏好设置：{error}"))
}

fn read_preferences(path: &Path) -> Result<DesktopPreferences, String> {
    if !path.exists() {
        return Ok(DesktopPreferences::default());
    }
    let payload = crate::shell_fs::read_regular_file_bounded(path, MAX_DESKTOP_PREFERENCES_BYTES)?;
    serde_json::from_slice(&payload).map_err(|error| format!("无法解析桌面偏好设置：{error}"))
}

fn write_preferences(path: &Path, preferences: &DesktopPreferences) -> Result<(), String> {
    let payload = serde_json::to_vec_pretty(preferences)
        .map_err(|error| format!("无法序列化桌面偏好设置：{error}"))?;
    crate::paths::write_private_file(path, &payload)
}

pub(crate) fn load(app: &AppHandle) -> Result<DesktopPreferences, String> {
    let path = preferences_path(app)?;
    let _guard = preferences_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    read_preferences(&path)
}

/// Returns true only once per installation and persists that decision before
/// the native notification is displayed, preventing repeated notices.
fn take_background_notice_at(path: &Path) -> Result<bool, String> {
    let mut preferences = read_preferences(path).unwrap_or_default();
    if preferences.background_notice_shown {
        return Ok(false);
    }
    preferences.background_notice_shown = true;
    write_preferences(path, &preferences)?;
    Ok(true)
}

pub(crate) fn take_background_notice(app: &AppHandle) -> Result<bool, String> {
    let path = preferences_path(app)?;
    let _guard = preferences_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    take_background_notice_at(&path)
}

#[tauri::command]
pub(crate) fn desktop_preferences_get(app: AppHandle) -> Result<DesktopPreferencesView, String> {
    load(&app).map(|preferences| DesktopPreferencesView::from(&preferences))
}

#[tauri::command]
pub(crate) fn desktop_preferences_save(
    app: AppHandle,
    close_to_tray: bool,
) -> Result<DesktopPreferencesView, String> {
    let path = preferences_path(&app)?;
    let _guard = preferences_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // A malformed preferences file must not permanently lock the settings UI.
    // Saving an explicit user choice repairs this non-critical file.
    let mut preferences = read_preferences(&path).unwrap_or_default();
    preferences.close_to_tray = close_to_tray;
    write_preferences(&path, &preferences)?;
    Ok(DesktopPreferencesView::from(&preferences))
}

#[tauri::command]
pub(crate) fn desktop_notification_preview_save(
    app: AppHandle,
    show_task_title: bool,
) -> Result<DesktopPreferencesView, String> {
    let path = preferences_path(&app)?;
    let _guard = preferences_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut preferences = read_preferences(&path).unwrap_or_default();
    preferences.show_notification_task_title = show_task_title;
    write_preferences(&path, &preferences)?;
    Ok(DesktopPreferencesView::from(&preferences))
}

#[cfg(test)]
mod tests {
    use super::{
        read_preferences, take_background_notice_at, write_preferences, DesktopPreferences,
    };

    #[test]
    fn missing_file_defaults_to_background_residency() {
        let dir = tempfile::tempdir().unwrap();
        let preferences = read_preferences(&dir.path().join("missing.json")).unwrap();

        assert!(preferences.close_to_tray);
        assert!(!preferences.show_notification_task_title);
        assert!(!preferences.background_notice_shown);
    }

    #[test]
    fn preferences_round_trip_preserves_notice_state() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("desktop-preferences.json");
        let preferences = DesktopPreferences {
            close_to_tray: false,
            show_notification_task_title: true,
            background_notice_shown: true,
        };

        write_preferences(&path, &preferences).unwrap();

        assert_eq!(read_preferences(&path).unwrap(), preferences);
    }

    #[test]
    fn older_empty_payload_uses_new_defaults() {
        let preferences: DesktopPreferences = serde_json::from_str("{}").unwrap();

        assert!(preferences.close_to_tray);
        assert!(!preferences.show_notification_task_title);
        assert!(!preferences.background_notice_shown);
    }

    #[test]
    fn malformed_preferences_are_reported() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("desktop-preferences.json");
        std::fs::write(&path, b"not-json").unwrap();

        let error = read_preferences(&path).unwrap_err();
        assert!(error.contains("无法解析桌面偏好设置"));
    }

    #[test]
    fn background_notice_is_taken_only_once_without_changing_close_behavior() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("desktop-preferences.json");
        write_preferences(
            &path,
            &DesktopPreferences {
                close_to_tray: false,
                show_notification_task_title: false,
                background_notice_shown: false,
            },
        )
        .unwrap();

        assert!(take_background_notice_at(&path).unwrap());
        assert!(!take_background_notice_at(&path).unwrap());
        assert!(!read_preferences(&path).unwrap().close_to_tray);
    }
}
