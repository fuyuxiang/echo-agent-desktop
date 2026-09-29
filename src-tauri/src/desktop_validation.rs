//! Release gate: a real WebView renders the app and completes a native IPC call.
//! Only active in a deliberately isolated validation launch.
use tauri::Manager;

#[tauri::command]
pub async fn desktop_validation_ready(
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
        "office/worker.mjs",
        "office/fonts/NotoSansCJKsc-Regular.otf",
    ] {
        if !resources.join(relative).is_file() {
            return Err(format!("Packaged resource missing: {relative}"));
        }
    }
    // Start the IDE from the packaged resource path. Staged-resource tests
    // cannot catch packaging errors such as missing native modules or lost
    // executable permissions on macOS.
    #[cfg(any(windows, target_os = "macos"))]
    let ide_error = async {
        let workspace = crate::paths::echo_agent_home_dir().join("中文项目验证");
        std::fs::create_dir_all(&workspace).map_err(|error| error.to_string())?;
        let access = app.state::<crate::shell_fs::FilesystemAccess>();
        let authorized = access.authorize_workspace(&workspace.to_string_lossy())?;
        let server = app.state::<crate::theia::TheiaServer>();
        let result = crate::theia::coding_theia_start(
            app.clone(),
            access,
            server,
            authorized.to_string_lossy().into_owned(),
        )
        .await;
        app.state::<crate::theia::TheiaServer>().stop();
        result.map(|_| ())
    }
    .await
    .err();
    #[cfg(not(any(windows, target_os = "macos")))]
    let ide_error: Option<String> = None;
    crate::paths::write_private_file(
        &crate::paths::echo_agent_home_dir().join("desktop-validation.json"),
        &serde_json::to_vec(&serde_json::json!({
            "version": env!("CARGO_PKG_VERSION"), "platform": std::env::consts::OS,
            "webviewRendered": true, "ipcReady": true, "resourcesPresent": true,
            "ideStarted": cfg!(any(windows, target_os = "macos")) && ide_error.is_none(),
            "ideError": ide_error,
        }))
        .map_err(|e| e.to_string())?,
    )?;
    crate::request_graceful_exit(app);
    Ok(())
}
