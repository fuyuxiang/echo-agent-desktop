//! Release gate: a real WebView renders the app and completes a native IPC call.
//! Only active in a deliberately isolated validation launch.
use tauri::Manager;

#[tauri::command]
pub fn desktop_validation_ready(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    if std::env::var("ECHO_DESKTOP_VALIDATION").as_deref() != Ok("1") {
        return Ok(());
    }
    if window.label() != "main" || std::env::var_os("ECHO_AGENT_HOME").is_none() {
        return Err("Validation requires an isolated runtime home and the main window".into());
    }
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    for relative in [
        "theia/browser/lib/backend/main.js",
        if cfg!(windows) {
            "theia/node/node.exe"
        } else {
            "theia/node/bin/node"
        },
    ] {
        if !resources.join(relative).is_file() {
            return Err(format!("Packaged resource missing: {relative}"));
        }
    }
    crate::paths::write_private_file(
        &crate::paths::echo_agent_home_dir().join("desktop-validation.json"),
        &serde_json::to_vec(&serde_json::json!({
            "version": env!("CARGO_PKG_VERSION"), "platform": std::env::consts::OS,
            "webviewRendered": true, "ipcReady": true, "resourcesPresent": true,
        }))
        .map_err(|e| e.to_string())?,
    )?;
    crate::request_graceful_exit(app);
    Ok(())
}
