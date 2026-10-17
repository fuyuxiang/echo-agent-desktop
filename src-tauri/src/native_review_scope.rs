//! Shared private scope checks for native acceptance.
use std::path::Path;

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
        return Err("Native review requires the main internal application page".into());
    }
    Ok(())
}

pub(crate) fn ordinary_private(path: &Path, directory: bool) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink()
        || metadata.is_dir() != directory
        || (!directory && !metadata.is_file())
        || std::fs::canonicalize(path).map_err(|error| error.to_string())? != path
    {
        return Err("Native review requires canonical ordinary private paths".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("Native review path is not private".into());
        }
        Ok(())
    }
    #[cfg(not(unix))]
    Err("Native review currently requires Unix private permissions".into())
}
