//! Filesystem identity, never a renderer-wide case-folding rule.
use serde::Serialize;
use std::path::Path;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceIdentity {
    pub id: String,
    pub canonical_path: String,
}

pub fn identity(path: &Path) -> Result<ResourceIdentity, String> {
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("无法解析文件路径：{e}"))?;
    #[cfg(unix)]
    let id = {
        use std::os::unix::fs::MetadataExt;
        let metadata = canonical.metadata().map_err(|e| e.to_string())?;
        format!("fs-{:x}-{:x}", metadata.dev(), metadata.ino())
    };
    #[cfg(not(unix))]
    let id = {
        use sha2::{Digest, Sha256};
        // canonicalize resolves the actual on-disk spelling, including Windows
        // case-sensitive directories. Do not lower-case it.
        format!(
            "fs-{:x}",
            Sha256::digest(canonical.to_string_lossy().as_bytes())
        )
    };
    Ok(ResourceIdentity {
        id,
        canonical_path: canonical.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn filesystem_resource_identity(
    access: State<'_, crate::shell_fs::FilesystemAccess>,
    path: String,
    directory: bool,
) -> Result<ResourceIdentity, String> {
    let authorized = if directory {
        access.require_workspace(&path)?
    } else {
        access.require_authorized_file(Path::new(&path))?
    };
    identity(&authorized)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn identity_resolves_aliases_without_global_case_folding() {
        let directory = tempfile::tempdir().unwrap();
        let upper = directory.path().join("A.txt");
        let lower = directory.path().join("a.txt");
        std::fs::write(&upper, b"upper").unwrap();
        std::fs::write(&lower, b"lower").unwrap();
        let alias = directory.path().join("alias.txt");
        std::os::unix::fs::symlink(&upper, &alias).unwrap();
        assert_eq!(identity(&upper).unwrap().id, identity(&alias).unwrap().id);
        let same_file = std::fs::read(&upper).unwrap() == b"lower";
        assert_eq!(
            identity(&upper).unwrap().id == identity(&lower).unwrap().id,
            same_file
        );
    }
}
