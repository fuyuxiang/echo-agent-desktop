//! Fixed private Git/IDE acceptance; no caller-supplied script or shell command.
use crate::native_review_scope::{ordinary_private, require_main_internal};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

static STARTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema: u8,
    kind: String,
    home: PathBuf,
    cwd: PathBuf,
    nonce: String,
    generation: String,
    phase: String,
    expected: Option<Expected>,
    file: String,
    initial_head: String,
    preview_url: String,
    version1: String,
    version2: String,
    version3: String,
    commit_message: String,
    baseline_files: BTreeMap<String, String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Expected {
    initial_head: String,
    committed_head: String,
    version3: String,
    file: String,
    worktree_root: PathBuf,
    original_task_id: String,
    worktree_saved_version: String,
}

fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn validate(value: &Manifest, home: &Path) -> Result<(), String> {
    if value.schema != 1
        || value.kind != "ide-git-boundary"
        || value.home != home
        || value.cwd != home.join("workspaces/default")
        || !hex(&value.nonce, 32)
        || !hex(&value.generation, 32)
        || !matches!(
            (value.phase.as_str(), value.expected.as_ref()),
            ("first-launch", None) | ("restart", Some(_))
        )
        || value.file != "IDE边界验收.txt"
        || !(hex(&value.initial_head, 40) || hex(&value.initial_head, 64))
        || value.commit_message != "Private IDE fixture change"
        || value.baseline_files.len() != 2
        || ["ide-terminal-proof.cjs", ".gitignore"].iter().any(|name| {
            !value
                .baseline_files
                .get(*name)
                .is_some_and(|hash| hex(hash, 64))
        })
        || [&value.version1, &value.version2, &value.version3]
            .iter()
            .enumerate()
            .any(|(index, version)| {
                **version
                    != format!(
                        "IDE_CONTENT_{}\nEcho IDE boundary version {}\n",
                        value.generation,
                        index + 1
                    )
            })
    {
        return Err("IDE review manifest has an unexpected fixed fixture".into());
    }
    if let Some(expected) = &value.expected {
        let managed = home.join("coding-worktrees");
        let relative = expected
            .worktree_root
            .strip_prefix(&managed)
            .map_err(|_| "Foreign IDE restart worktree")?;
        let parts: Vec<_> = relative.iter().collect();
        let worktree_id = parts
            .first()
            .and_then(|part| part.to_str())
            .and_then(|id| uuid::Uuid::parse_str(id).ok());
        if parts.len() != 2
            || parts[1] != "worktree"
            || worktree_id.is_none()
            || uuid::Uuid::parse_str(&expected.original_task_id).is_err()
            || expected.initial_head != value.initial_head
            || expected.committed_head == expected.initial_head
            || !(hex(&expected.committed_head, 40) || hex(&expected.committed_head, 64))
            || expected.file != value.file
            || expected.version3 != value.version3
            || expected.worktree_saved_version != value.version1
        {
            return Err("IDE restart does not match its exact owned first-launch results".into());
        }
    }
    let url = url::Url::parse(&value.preview_url).map_err(|_| "Invalid IDE preview URL")?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || !url.port().is_some_and(|port| port > 0)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != format!("/ide-preview/{}", value.generation)
        || url.as_str() != value.preview_url
    {
        return Err("IDE review requires its exact synthetic loopback preview".into());
    }
    Ok(())
}

fn read_manifest() -> Result<Manifest, String> {
    if std::env::var("ECHO_DESKTOP_REVIEW").as_deref() != Ok("1")
        || std::env::var("ECHO_DESKTOP_REVIEW_IDE").as_deref() != Ok("1")
        || !matches!(
            std::env::var("ECHO_DESKTOP_REVIEW_PHASE").as_deref(),
            Ok("first-launch" | "restart")
        )
    {
        return Err("IDE review is not enabled in its fixed phase".into());
    }
    let home = crate::paths::redirected_data_home().ok_or("IDE review home is not redirected")?;
    ordinary_private(&home, true)?;
    let configured = PathBuf::from(std::env::var_os("ECHO_AGENT_HOME").ok_or("Missing IDE home")?);
    let temporary =
        std::fs::canonicalize(std::env::temp_dir()).map_err(|error| error.to_string())?;
    let private_tmp = std::fs::canonicalize("/private/tmp").map_err(|error| error.to_string())?;
    if home != configured
        || !home
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                name.strip_prefix("echo-native-review-ide-")
                    .is_some_and(|suffix| {
                        !suffix.is_empty()
                            && suffix.bytes().all(|byte| {
                                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')
                            })
                    })
            })
        || !((home.starts_with(&temporary) && home != temporary)
            || (home.starts_with(&private_tmp) && home != private_tmp))
    {
        return Err("IDE review requires a canonical private temporary home".into());
    }
    let path = home.join("native-ide-manifest.private.json");
    ordinary_private(&path, false)?;
    if std::fs::metadata(&path)
        .map_err(|error| error.to_string())?
        .len()
        > 64 * 1024
    {
        return Err("IDE review manifest is too large".into());
    }
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    if bytes.len() > 64 * 1024 {
        return Err("IDE review manifest is too large".into());
    }
    let value: Manifest =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid IDE review manifest")?;
    validate(&value, &home)?;
    if std::env::var("ECHO_DESKTOP_REVIEW_PHASE").as_deref() != Ok(value.phase.as_str()) {
        return Err("IDE manifest differs from the current native launch phase".into());
    }
    ordinary_private(&home.join("workspaces"), true)?;
    ordinary_private(&value.cwd, true)?;
    for name in ["IDE边界验收.txt", "ide-terminal-proof.cjs", ".gitignore"] {
        ordinary_private(&value.cwd.join(name), false)?;
    }
    Ok(value)
}

#[tauri::command]
pub fn desktop_review_ide_manifest(
    window: tauri::WebviewWindow,
) -> Result<serde_json::Value, String> {
    require_main_internal(&window)?;
    serde_json::to_value(read_manifest()?).map_err(|error| error.to_string())
}

pub(crate) async fn launch(window: tauri::WebviewWindow) -> Result<(), String> {
    require_main_internal(&window)?;
    let manifest = read_manifest()?;
    if STARTED.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = manifest;
        Err("IDE review currently requires the macOS WKWebView driver".into())
    }
    #[cfg(target_os = "macos")]
    {
        use objc2::{MainThreadMarker, MainThreadOnly};
        use objc2_foundation::NSString;
        use objc2_web_kit::{WKUserContentController, WKUserScript, WKUserScriptInjectionTime};
        let scope = serde_json::to_string(&manifest).map_err(|error| error.to_string())?;
        let child = format!(
            "{}({scope});",
            include_str!("../../scripts/fixtures/native-ide-git-frame-review.js")
        );
        let (sender, receiver) = tokio::sync::oneshot::channel();
        window
            .with_webview(move |webview| {
                let installed = (|| {
                    let marker = MainThreadMarker::new()
                        .ok_or("IDE WK installation was not on the main thread")?;
                    // Preserve existing production Tauri/bridge scripts.
                    unsafe {
                        let controller = webview.controller().cast::<WKUserContentController>();
                        let controller =
                            controller.as_ref().ok_or("IDE WK controller unavailable")?;
                        let source = NSString::from_str(&child);
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
            .map_err(|_| "IDE WK installation timed out")?
            .map_err(|_| "IDE WK installation interrupted")?
            .map_err(str::to_string)?;
        window
            .eval(format!(
                "{}({scope});",
                include_str!("../../scripts/fixtures/native-ide-git-review.js")
            ))
            .map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Manifest {
        let home = PathBuf::from("/private/tmp/echo-native-review-ide-test");
        let generation = "b".repeat(32);
        let version =
            |index| format!("IDE_CONTENT_{generation}\nEcho IDE boundary version {index}\n");
        Manifest {
            schema: 1,
            kind: "ide-git-boundary".into(),
            cwd: home.join("workspaces/default"),
            home,
            nonce: "a".repeat(32),
            phase: "first-launch".into(),
            expected: None,
            file: "IDE边界验收.txt".into(),
            initial_head: "c".repeat(40),
            preview_url: format!("http://127.0.0.1:34567/ide-preview/{generation}"),
            version1: version(1),
            version2: version(2),
            version3: version(3),
            generation,
            commit_message: "Private IDE fixture change".into(),
            baseline_files: BTreeMap::from([
                ("ide-terminal-proof.cjs".into(), "d".repeat(64)),
                (".gitignore".into(), "e".repeat(64)),
            ]),
        }
    }
    #[test]
    fn ide_scope_rejects_foreign_repository_script_preview_and_versions() {
        let home = fixture().home;
        assert!(validate(&fixture(), &home).is_ok());
        let mut value = fixture();
        value.cwd = PathBuf::from("/outside");
        assert!(validate(&value, &home).is_err());
        let mut value = fixture();
        value.preview_url = "https://example.com/".into();
        assert!(validate(&value, &home).is_err());
        let mut value = fixture();
        value.version2 = "arbitrary code".into();
        assert!(validate(&value, &home).is_err());
        let mut value = fixture();
        value.commit_message = "other".into();
        assert!(validate(&value, &home).is_err());
        let mut value = fixture();
        value
            .baseline_files
            .insert("unapproved.sh".into(), "f".repeat(64));
        assert!(validate(&value, &home).is_err());
    }
    #[test]
    fn ide_scope_rejects_unknown_manifest_field_and_unapproved_phase() {
        let mut json = serde_json::to_value(fixture()).unwrap();
        json["script"] = "arbitrary".into();
        assert!(serde_json::from_value::<Manifest>(json).is_err());
        let mut value = fixture();
        let home = value.home.clone();
        value.phase = "restart".into();
        assert!(validate(&value, &home).is_err());
        let mut value = fixture();
        value.expected = Some(restart_expected());
        assert!(validate(&value, &home).is_err());
    }

    fn restart_expected() -> Expected {
        let value = fixture();
        Expected {
            initial_head: value.initial_head,
            committed_head: "f".repeat(40),
            version3: value.version3,
            file: value.file,
            worktree_root: value
                .home
                .join("coding-worktrees/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/worktree"),
            original_task_id: "11111111-2222-3333-4444-555555555555".into(),
            worktree_saved_version: value.version1,
        }
    }

    #[test]
    fn ide_restart_rejects_foreign_worktree_task_and_saved_content() {
        let mut value = fixture();
        value.phase = "restart".into();
        value.expected = Some(restart_expected());
        let home = value.home.clone();
        assert!(validate(&value, &home).is_ok());
        value.expected.as_mut().unwrap().worktree_root = PathBuf::from("/foreign/worktree");
        assert!(validate(&value, &home).is_err());
        value.expected = Some(restart_expected());
        value.expected.as_mut().unwrap().original_task_id = "../other".into();
        assert!(validate(&value, &home).is_err());
        value.expected = Some(restart_expected());
        value.expected.as_mut().unwrap().worktree_saved_version = "other bytes".into();
        assert!(validate(&value, &home).is_err());
    }
}
