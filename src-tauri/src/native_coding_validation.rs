//! Deliberately isolated, opt-in native Echo Code acceptance.
//! There is no command accepting caller supplied JavaScript or path grants.
use std::sync::atomic::{AtomicBool, Ordering};

static RUN_STARTED: AtomicBool = AtomicBool::new(false);

fn require_isolated_code_review(
    window: &tauri::WebviewWindow,
) -> Result<std::path::PathBuf, String> {
    if std::env::var("ECHO_DESKTOP_REVIEW").as_deref() != Ok("1")
        || std::env::var("ECHO_DESKTOP_REVIEW_CODE").as_deref() != Ok("1")
        || window.label() != "main"
    {
        return Err("Code acceptance requires the dedicated review flags and main window".into());
    }
    let selected = crate::paths::redirected_data_home()
        .ok_or("Code acceptance requires an explicitly redirected data home")?;
    let configured = std::env::var_os("ECHO_AGENT_HOME")
        .map(std::path::PathBuf::from)
        .ok_or("Code acceptance requires ECHO_AGENT_HOME")?;
    let canonical = std::fs::canonicalize(&selected).map_err(|error| error.to_string())?;
    if canonical != selected || canonical != configured || !canonical.is_dir() {
        return Err("Code acceptance requires the canonical, existing redirected home".into());
    }
    let temporary =
        std::fs::canonicalize(std::env::temp_dir()).map_err(|error| error.to_string())?;
    let private_tmp = std::fs::canonicalize("/private/tmp").ok();
    let inside_temporary_home = (canonical.starts_with(&temporary) && canonical != temporary)
        || private_tmp
            .as_ref()
            .is_some_and(|root| canonical.starts_with(root) && canonical != *root);
    if !inside_temporary_home {
        return Err("Code acceptance may only use a nested temporary data home".into());
    }
    let name = canonical
        .file_name()
        .and_then(std::ffi::OsStr::to_str)
        .ok_or("Code acceptance home must have a readable fixture name")?;
    if !name.starts_with("echo-native-review-") {
        return Err("Code acceptance must continue an isolated native review fixture".into());
    }
    Ok(canonical)
}

/// The caller must also apply the existing `require_review_launch` gate before
/// dispatching its dedicated code branch. This function checks its own boundary.
pub(crate) async fn run(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    let home = require_isolated_code_review(&window)?;
    if RUN_STARTED
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, home);
        Err("Native Code acceptance currently requires the macOS WKWebView driver".into())
    }
    #[cfg(target_os = "macos")]
    {
        run_macos(app, window, home).await
    }
}

#[cfg(target_os = "macos")]
async fn run_macos(
    _app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    home: std::path::PathBuf,
) -> Result<(), String> {
    use objc2::{MainThreadMarker, MainThreadOnly};
    use objc2_foundation::NSString;
    use objc2_web_kit::{WKUserContentController, WKUserScript, WKUserScriptInjectionTime};

    let home = home
        .to_str()
        .ok_or("Native Code acceptance requires a UTF-8 temporary fixture path")?;
    // Two independently random UUIDv7 tails, created natively per launch. The
    // nonce is not exposed in a child global, persisted, or printed in reports.
    let nonce = format!("{}{}", uuid::Uuid::now_v7(), uuid::Uuid::now_v7());
    let scope = serde_json::json!({
        "home": home,
        "nonce": nonce,
        "continueExistingTask": std::env::var("ECHO_DESKTOP_REVIEW_CODE_CONTINUE").as_deref() == Ok("1"),
        "continueDeliveryReview": std::env::var("ECHO_DESKTOP_REVIEW_CODE_DELIVERY_CONTINUE").as_deref() == Ok("1"),
    });
    let child_script = format!(
        "{}({});",
        include_str!("../../scripts/fixtures/native-coding-frame-review.js"),
        scope
    );
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |webview| {
            let installed = (|| {
                let marker = MainThreadMarker::new()
                    .ok_or("WK script installation did not run on the main thread")?;
                // Tauri documents this macOS controller as WKUserContentController.
                // The controller retains the script; preserve the existing Tauri
                // user scripts and their production IPC isolation.
                unsafe {
                    let controller = webview.controller().cast::<WKUserContentController>();
                    let controller = controller
                        .as_ref()
                        .ok_or("WK user content controller is unavailable")?;
                    let source = NSString::from_str(&child_script);
                    let script = WKUserScript::initWithSource_injectionTime_forMainFrameOnly(
                        WKUserScript::alloc(marker),
                        &source,
                        WKUserScriptInjectionTime::AtDocumentStart,
                        false,
                    );
                    controller.addUserScript(&script);
                }
                Ok::<(), &'static str>(())
            })();
            let _ = sender.send(installed);
        })
        .map_err(|error| error.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(15), receiver)
        .await
        .map_err(|_| "WK script installation timed out".to_string())?
        .map_err(|_| "WK script installation was interrupted".to_string())?
        .map_err(str::to_string)?;

    let launch = include_str!("../../scripts/fixtures/native-coding-launch.js");
    let parent_script = format!(
        "{}\n{}({});",
        include_str!("../../scripts/fixtures/native-coding-review.js"),
        launch,
        scope
    );
    window
        .eval(&parent_script)
        .map_err(|error| error.to_string())
}
