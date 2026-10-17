//! Fixed private acceptance scope. Never grants arbitrary data-home file access.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

static STARTED: AtomicBool = AtomicBool::new(false);

pub(crate) fn require_main_internal(window: &tauri::WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|error| error.to_string())?;
    if window.label() != "main"
        || !matches!(url.scheme(), "tauri" | "http" | "https")
        || !matches!(url.host_str(), Some("localhost" | "tauri.localhost"))
        || (url.scheme() != "tauri" && url.host_str() != Some("tauri.localhost"))
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/" | "/index.html")
    {
        return Err("Capabilities review requires the main internal application page".into());
    }
    Ok(())
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema: u8,
    #[serde(default = "crate::native_review_model::default_model")]
    model_id: String,
    home: PathBuf,
    cwd: PathBuf,
    token: String,
    source_url: String,
    ca_path: PathBuf,
    plugin_name: String,
    marketplace_name: String,
    plugin_relative_path: String,
    initial_commit: String,
    memory_seed: String,
    #[serde(rename = "memorySeedSHA256")]
    memory_seed_sha256: String,
    memory_restored_seed: String,
}

fn lowercase_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub(crate) fn ordinary_private(path: &Path, directory: bool) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink()
        || metadata.is_dir() != directory
        || (!directory && !metadata.is_file())
        || std::fs::canonicalize(path).map_err(|error| error.to_string())? != path
    {
        return Err("Capabilities review requires canonical ordinary private paths".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("Capabilities review path is not private".into());
        }
        Ok(())
    }
    #[cfg(not(unix))]
    Err("Capabilities review currently requires Unix private permissions".into())
}

fn review_home() -> Result<PathBuf, String> {
    if std::env::var("ECHO_DESKTOP_REVIEW").as_deref() != Ok("1")
        || std::env::var("ECHO_DESKTOP_REVIEW_CAPABILITIES").as_deref() != Ok("1")
    {
        return Err("Capabilities review is not enabled".into());
    }
    let home = crate::paths::redirected_data_home().ok_or("Capabilities home is not redirected")?;
    let configured =
        PathBuf::from(std::env::var_os("ECHO_AGENT_HOME").ok_or("Missing capabilities home")?);
    ordinary_private(&home, true)?;
    let temporary =
        std::fs::canonicalize(std::env::temp_dir()).map_err(|error| error.to_string())?;
    let private_tmp = std::fs::canonicalize("/private/tmp").map_err(|error| error.to_string())?;
    if configured != home
        || !home
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                name.strip_prefix("echo-native-review-capabilities-")
                    .is_some_and(|suffix| {
                        !suffix.is_empty()
                            && suffix.bytes().all(|byte| byte.is_ascii_alphanumeric())
                    })
            })
        || !((home.starts_with(&temporary) && home != temporary)
            || (home.starts_with(&private_tmp) && home != private_tmp))
    {
        return Err("Capabilities review requires its own canonical private temporary home".into());
    }
    Ok(home)
}

fn validate_manifest(manifest: &Manifest, home: &Path) -> Result<(), String> {
    if !lowercase_hex(&manifest.token, 64) {
        return Err("Invalid capabilities fixture token".into());
    }
    let suffix = &manifest.token[..12];
    let plugin_name = format!("echo-capabilities-review-{suffix}");
    let marketplace_name = format!("echo-capabilities-market-{suffix}");
    let seed = format!("# 隔离全局记忆\n\n仅供本机验收删除的种子 {suffix}。\n");
    let restored = format!("# 隔离全局记忆恢复\n\n由真实追加记忆入口重建 {suffix}。\n");
    let url = url::Url::parse(&manifest.source_url).map_err(|_| "Invalid capabilities Git URL")?;
    if manifest.schema != 1
        || !crate::native_review_model::allowed_model(&manifest.model_id)
        || manifest.home != home
        || manifest.cwd != home.join("workspaces/default")
        || manifest.ca_path != home.join("capabilities-git-resource/ca.crt")
        || manifest.plugin_name != plugin_name
        || manifest.marketplace_name != marketplace_name
        || manifest.plugin_relative_path != format!("plugins/{plugin_name}")
        || !lowercase_hex(&manifest.initial_commit, 40)
        || manifest.memory_seed != seed
        || manifest.memory_restored_seed != restored
        || manifest.memory_seed_sha256 != format!("{:x}", Sha256::digest(seed.as_bytes()))
        || url.scheme() != "https"
        || url.host_str() != Some("127.0.0.1")
        || !url.port().is_some_and(|port| port > 0)
        || url.path() != format!("/{marketplace_name}.git")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Capabilities fixture does not match its fixed owned scope".into());
    }
    Ok(())
}

fn read_manifest(home: &Path) -> Result<Manifest, String> {
    for directory in [
        home.join("workspaces"),
        home.join("workspaces/default"),
        home.join("capabilities-git-resource"),
    ] {
        ordinary_private(&directory, true)?;
    }
    let path = home.join("workspaces/default/capabilities-fixture.json");
    ordinary_private(&path, false)?;
    if std::fs::metadata(&path)
        .map_err(|error| error.to_string())?
        .len()
        > 8192
    {
        return Err("Capabilities manifest is too large".into());
    }
    let bytes = std::fs::read(&path).map_err(|error| error.to_string())?;
    if bytes.len() > 8192 {
        return Err("Capabilities manifest is too large".into());
    }
    let manifest: Manifest =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid capabilities manifest")?;
    validate_manifest(&manifest, home)?;
    crate::native_review_model::validate_config(home, &manifest.model_id)?;
    ordinary_private(&manifest.ca_path, false)?;
    Ok(manifest)
}

pub(crate) fn launch(window: &tauri::WebviewWindow) -> Result<(), String> {
    require_main_internal(window)?;
    let home = review_home()?;
    read_manifest(&home)?;
    if STARTED.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    let scope = serde_json::json!({"home": home, "nonce": format!("{}{}", uuid::Uuid::now_v7(), uuid::Uuid::now_v7())});
    let factory = include_str!("../../scripts/fixtures/native-capabilities-review.js");
    window
        .eval(format!("{factory}({scope});"))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn desktop_review_capabilities_manifest(
    window: tauri::WebviewWindow,
) -> Result<serde_json::Value, String> {
    require_main_internal(&window)?;
    let home = review_home()?;
    let manifest = read_manifest(&home)?;
    let (install_root, cache_root) = echo_agent_runtime::plugin::marketplace_storage_roots();
    if install_root != home.join("installed-plugins")
        || cache_root != home.join("marketplace-cache")
    {
        return Err("Actual Runtime plugin storage escaped the private review home".into());
    }
    ordinary_private(&install_root, true)?;
    ordinary_private(&cache_root, true)?;
    let memory_directory = home.join("memory");
    ordinary_private(&memory_directory, true)?;
    let path = memory_directory.join("MEMORY.md");
    let (exists, digest, size) = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => {
            ordinary_private(&path, false)?;
            if metadata.len() > 4 * 1024 * 1024 {
                return Err("Capabilities memory proof exceeds its size limit".into());
            }
            let bytes = std::fs::read(&path).map_err(|error| error.to_string())?;
            if bytes.len() > 4 * 1024 * 1024 {
                return Err("Capabilities memory proof exceeds its size limit".into());
            }
            (
                true,
                Some(format!("{:x}", Sha256::digest(&bytes))),
                bytes.len(),
            )
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (false, None, 0),
        Err(error) => return Err(error.to_string()),
    };
    Ok(serde_json::json!({"manifest": manifest,
        "globalMemory": {"path": path, "exists": exists, "sha256": digest, "size": size},
        "pluginStorage": {"installRoot": install_root, "cacheRoot": cache_root}}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Manifest {
        let home = PathBuf::from("/private/tmp/echo-native-review-capabilities-test");
        let suffix = "a".repeat(12);
        let seed = format!("# 隔离全局记忆\n\n仅供本机验收删除的种子 {suffix}。\n");
        Manifest {
            schema: 1,
            model_id: crate::native_review_model::default_model(),
            cwd: home.join("workspaces/default"),
            ca_path: home.join("capabilities-git-resource/ca.crt"),
            home,
            token: "a".repeat(64),
            source_url: format!("https://127.0.0.1:18181/echo-capabilities-market-{suffix}.git"),
            plugin_name: format!("echo-capabilities-review-{suffix}"),
            marketplace_name: format!("echo-capabilities-market-{suffix}"),
            plugin_relative_path: format!("plugins/echo-capabilities-review-{suffix}"),
            initial_commit: "b".repeat(40),
            memory_seed_sha256: format!("{:x}", Sha256::digest(seed.as_bytes())),
            memory_seed: seed,
            memory_restored_seed: format!(
                "# 隔离全局记忆恢复\n\n由真实追加记忆入口重建 {suffix}。\n"
            ),
        }
    }

    #[test]
    fn capabilities_manifest_rejects_foreign_urls_paths_and_synthetic_seed_changes() {
        let original = fixture();
        let home = original.home.clone();
        assert!(validate_manifest(&original, &home).is_ok());
        for remote in [
            "http://127.0.0.1:18181/wrong.git",
            "https://example.com/a.git",
            "https://u:p@127.0.0.1:18181/a.git",
        ] {
            let mut value = fixture();
            value.source_url = remote.into();
            assert!(validate_manifest(&value, &home).is_err());
        }
        let mut value = fixture();
        value.ca_path = PathBuf::from("/outside/ca.crt");
        assert!(validate_manifest(&value, &home).is_err());
        let mut value = fixture();
        value.cwd = home.join("../other");
        assert!(validate_manifest(&value, &home).is_err());
        let mut value = fixture();
        value.memory_seed = "existing user data".into();
        assert!(validate_manifest(&value, &home).is_err());
        let mut value = fixture();
        value.token = "A".repeat(64);
        assert!(validate_manifest(&value, &home).is_err());
    }

    #[test]
    fn capabilities_manifest_preserves_sha_field_and_rejects_unknown_fields() {
        let mut value = serde_json::to_value(fixture()).unwrap();
        assert!(value.get("memorySeedSHA256").is_some());
        assert!(serde_json::from_value::<Manifest>(value.clone()).is_ok());
        value["path"] = "/arbitrary".into();
        assert!(serde_json::from_value::<Manifest>(value).is_err());
    }
}
