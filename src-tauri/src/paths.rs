//! EchoAgent runtime paths and one-time legacy data migration.
//!
//! EchoAgent owns `~/.echo-agent`. The embedded upstream engine still reads
//! its historical environment variable internally, so startup points that
//! variable at the EchoAgent directory after migrating any legacy data.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const HOME_ENV: &str = "ECHO_AGENT_HOME";
const UPSTREAM_HOME_ENV: &str = "GROK_HOME";
const HOME_DIR_NAME: &str = ".echo-agent";
const LEGACY_HOME_DIR_NAME: &str = ".grok";
const MIGRATION_MARKER: &str = ".legacy-data-migrated";

/// Resolve EchoAgent's user data directory.
pub fn echo_agent_home_dir() -> PathBuf {
    std::env::var_os(HOME_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(HOME_DIR_NAME)
        })
}

fn legacy_home_dir() -> PathBuf {
    std::env::var_os(UPSTREAM_HOME_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(LEGACY_HOME_DIR_NAME)
        })
}

/// Configure the embedded engine to use EchoAgent's home and import legacy
/// data once. Existing EchoAgent files always win; migration never overwrites
/// them and leaves the legacy directory untouched for rollback.
pub fn initialize_runtime_home() -> Result<PathBuf, String> {
    let target = echo_agent_home_dir();
    let legacy = legacy_home_dir();

    // Compatibility boundary: the embedded upstream crates currently expose
    // this environment variable as their home-directory override. Set it even
    // if migration later reports an I/O error, so new writes never fall back
    // to the legacy directory.
    std::env::set_var(UPSTREAM_HOME_ENV, &target);

    fs::create_dir_all(&target)
        .map_err(|e| format!("create EchoAgent home {}: {e}", target.display()))?;

    let marker = target.join(MIGRATION_MARKER);
    if legacy != target && legacy.is_dir() && !marker.exists() {
        merge_missing(&legacy, &target).map_err(|e| format!("migrate legacy agent data: {e}"))?;
        fs::write(
            &marker,
            b"Legacy agent data imported without overwriting existing files.\n",
        )
        .map_err(|e| format!("write migration marker {}: {e}", marker.display()))?;
    }

    Ok(target)
}

fn merge_missing(source: &Path, target: &Path) -> io::Result<()> {
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let destination = target.join(entry.file_name());

        if file_type.is_dir() {
            match fs::symlink_metadata(&destination) {
                Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                    continue;
                }
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    fs::create_dir(&destination)?;
                }
                Err(error) => return Err(error),
            }
            merge_missing(&entry.path(), &destination)?;
        } else if file_type.is_file() {
            copy_file_if_missing(&entry.path(), &destination)?;
        }
        // Symlinks are intentionally skipped: migration must not traverse or
        // recreate links that may point outside the legacy data directory.
    }
    Ok(())
}

fn copy_file_if_missing(source: &Path, destination: &Path) -> io::Result<()> {
    let mut input = fs::File::open(source)?;
    let mut output = match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => return Ok(()),
        Err(error) => return Err(error),
    };

    if let Err(error) = io::copy(&mut input, &mut output) {
        drop(output);
        let _ = fs::remove_file(destination);
        return Err(error);
    }
    if let Ok(permissions) = fs::metadata(source).map(|metadata| metadata.permissions()) {
        let _ = fs::set_permissions(destination, permissions);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::merge_missing;
    use std::fs;

    #[test]
    fn migration_copies_nested_files_without_overwriting() {
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        fs::create_dir_all(source.path().join("memory/nested")).unwrap();
        fs::create_dir_all(target.path().join("memory")).unwrap();
        fs::write(source.path().join("config.toml"), "legacy").unwrap();
        fs::write(source.path().join("memory/MEMORY.md"), "legacy memory").unwrap();
        fs::write(source.path().join("memory/nested/fact.md"), "fact").unwrap();
        fs::write(target.path().join("memory/MEMORY.md"), "current memory").unwrap();

        merge_missing(source.path(), target.path()).unwrap();

        assert_eq!(
            fs::read_to_string(target.path().join("config.toml")).unwrap(),
            "legacy"
        );
        assert_eq!(
            fs::read_to_string(target.path().join("memory/MEMORY.md")).unwrap(),
            "current memory"
        );
        assert_eq!(
            fs::read_to_string(target.path().join("memory/nested/fact.md")).unwrap(),
            "fact"
        );
    }

    #[test]
    fn migration_skips_incompatible_existing_entries() {
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        fs::create_dir_all(source.path().join("memory")).unwrap();
        fs::write(source.path().join("memory/fact.md"), "fact").unwrap();
        fs::write(target.path().join("memory"), "keep this file").unwrap();

        merge_missing(source.path(), target.path()).unwrap();

        assert_eq!(
            fs::read_to_string(target.path().join("memory")).unwrap(),
            "keep this file"
        );
    }
}
