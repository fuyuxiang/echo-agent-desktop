//! EchoAgent runtime paths and one-time legacy data migration.
//!
//! EchoAgent owns `~/.echo-agent`. The embedded upstream engine still reads
//! its historical environment variable internally, so startup points that
//! variable at the EchoAgent directory after migrating any legacy data.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

const HOME_ENV: &str = "ECHO_AGENT_HOME";
const UPSTREAM_HOME_ENV: &str = "GROK_HOME";
const UPSTREAM_AUTH_ENV: &str = "GROK_AUTH";
const UPSTREAM_AUTH_PATH_ENV: &str = "GROK_AUTH_PATH";
const SECURE_PROVIDER_URLS_ENV: &str = "ECHO_AGENT_ENFORCE_SECURE_PROVIDER_URLS";
const HOME_DIR_NAME: &str = ".echo-agent";
const LEGACY_HOME_DIR_NAME: &str = ".grok";
const MIGRATION_MARKER: &str = ".legacy-data-migrated";
const LEGACY_AUTH_FILE: &str = "auth.json";
const EXPERTS_MARKETPLACE_DIR_NAME: &str = "experts-marketplace";
const CONNECTORS_MARKETPLACE_DIR_NAME: &str = "connectors-marketplace";

/// Reject data roots owned by the retired WorkBuddy integration.
///
/// String normalization is intentional: a Windows path can reach a Unix test
/// build through persisted WebView storage, and vice versa.
pub(crate) fn reject_legacy_workbuddy_path(path: &Path) -> Result<(), String> {
    let contains_legacy_component =
        path.to_string_lossy()
            .replace('\\', "/")
            .split('/')
            .any(|component| {
                component.eq_ignore_ascii_case(".workbuddy")
                    || component.eq_ignore_ascii_case("workbuddy")
            });

    if contains_legacy_component {
        Err("已阻止读取 WorkBuddy 数据目录，请选择 EchoAgent 数据目录".into())
    } else {
        Ok(())
    }
}

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

/// Default user-visible workspace for sessions created without an explicit
/// folder selection. Keeping this in one dedicated directory avoids treating
/// the user's entire home directory as an implicit filesystem capability.
pub(crate) fn default_workspace_dir() -> Result<PathBuf, String> {
    let mut bases = Vec::new();
    if let Some(documents) = dirs::document_dir() {
        push_unique_path(&mut bases, documents);
    }
    if let Some(home) = dirs::home_dir() {
        push_unique_path(&mut bases, home);
    }
    if bases.is_empty() {
        return Err("无法确定默认工作区位置".into());
    }

    let mut last_error = None;
    for base in bases {
        let workspace = default_workspace_path(&base);
        if let Err(error) = fs::create_dir_all(&workspace) {
            last_error = Some(format!(
                "创建默认工作区 {} 失败：{error}",
                workspace.display()
            ));
            continue;
        }
        match workspace.canonicalize() {
            Ok(canonical) => return Ok(canonical),
            Err(error) => {
                last_error = Some(format!(
                    "无法解析默认工作区 {}：{error}",
                    workspace.display()
                ));
            }
        }
    }
    Err(last_error.unwrap_or_else(|| "无法创建默认工作区".into()))
}

fn default_workspace_path(base: &Path) -> PathBuf {
    base.join("EchoAgent Workspace")
}

/// Canonical roots for the catalogs shown in the Experts · Skills ·
/// Connectors panel. Keep these derived from `ECHO_AGENT_HOME`, just like the
/// runtime-owned agents, skills and MCP configuration, so a redirected data
/// home never leaves catalog reads behind in `~/.echo-agent`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CatalogRoots {
    pub experts: PathBuf,
    pub connectors: PathBuf,
    pub builtin_skills: PathBuf,
}

fn catalog_roots(data_home: &Path) -> CatalogRoots {
    CatalogRoots {
        experts: data_home.join(EXPERTS_MARKETPLACE_DIR_NAME),
        connectors: data_home.join(CONNECTORS_MARKETPLACE_DIR_NAME),
        builtin_skills: data_home.join("resources").join("builtin-skills"),
    }
}

pub(crate) fn experts_marketplace_dir() -> PathBuf {
    catalog_roots(&echo_agent_home_dir()).experts
}

pub(crate) fn connectors_marketplace_dir() -> PathBuf {
    catalog_roots(&echo_agent_home_dir()).connectors
}

pub(crate) fn builtin_skills_dir() -> PathBuf {
    catalog_roots(&echo_agent_home_dir()).builtin_skills
}

/// Resolve the first non-empty path override. The first name is the current
/// public spelling; later names are compatibility aliases retained for users
/// of older builds.
pub(crate) fn first_env_path(names: &[&str]) -> Option<PathBuf> {
    names.iter().find_map(|name| {
        std::env::var_os(name)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    })
}

pub(crate) fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.contains(&path) {
        paths.push(path);
    }
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
    // Tell the embedded sampler to reject insecure provider URLs loaded from
    // legacy or manually edited Runtime config. This is set by native startup,
    // not by the WebView, so request-time enforcement cannot be bypassed by
    // invoking a different settings command.
    std::env::set_var(SECURE_PROVIDER_URLS_ENV, "1");
    // EchoAgent uses only per-provider credentials. Remove upstream account
    // overrides before background threads start so the inert runtime adapter
    // cannot inherit an upstream account token from the parent process.
    std::env::remove_var(UPSTREAM_AUTH_ENV);
    std::env::remove_var(UPSTREAM_AUTH_PATH_ENV);

    fs::create_dir_all(&target)
        .map_err(|e| format!("create EchoAgent home {}: {e}", target.display()))?;
    harden_private_dir(&target)?;

    let marker = target.join(MIGRATION_MARKER);
    if legacy != target && legacy.is_dir() && !marker.exists() {
        merge_missing(&legacy, &target).map_err(|e| format!("migrate legacy agent data: {e}"))?;
        fs::write(
            &marker,
            b"Legacy agent data imported without overwriting existing files.\n",
        )
        .map_err(|e| format!("write migration marker {}: {e}", marker.display()))?;
    }

    // Catalogs used to be resolved independently from fixed locations under
    // the OS home directory. Import an existing valid catalog into the active
    // data home once, without overwriting a target or deleting the source.
    // Failure is non-fatal because the catalog resolvers retain legacy read
    // fallbacks and the rest of the application must remain usable.
    migrate_legacy_catalog_roots(&target);

    // Migration may have copied a world-readable legacy file. Harden it on
    // every startup so existing installations are repaired without requiring
    // the user to save provider settings again.
    let config = target.join("config.toml");
    if config.exists() {
        harden_private_file(&config)?;
    }

    Ok(target)
}

fn migrate_legacy_catalog_roots(data_home: &Path) {
    let Some(user_home) = dirs::home_dir() else {
        return;
    };
    let roots = catalog_roots(data_home);
    let old_default_home = user_home.join(HOME_DIR_NAME);

    let expert_source = [
        user_home.join("EchoAgent").join("agents"),
        user_home.join("agents"),
    ]
    .into_iter()
    .find(|path| path.join("_meta").join("_expert_center.json").is_file());
    if let Some(source) = expert_source {
        if let Err(error) = migrate_catalog_dir(&source, &roots.experts) {
            eprintln!("migrate legacy expert marketplace: {error}");
        }
    }

    let connector_source = old_default_home.join(CONNECTORS_MARKETPLACE_DIR_NAME);
    if connector_source
        .join(".echo-agent-connector")
        .join("connectors.json")
        .is_file()
    {
        if let Err(error) = migrate_catalog_dir(&connector_source, &roots.connectors) {
            eprintln!("migrate legacy connector marketplace: {error}");
        }
    }

    let builtin_source = old_default_home.join("resources").join("builtin-skills");
    if builtin_source.is_dir() {
        if let Err(error) = migrate_catalog_dir(&builtin_source, &roots.builtin_skills) {
            eprintln!("migrate legacy built-in skills: {error}");
        }
    }
}

/// Copy a legacy catalog through a sibling staging directory, then rename it
/// into place. The rename makes an interrupted import distinguishable from a
/// complete target and ensures an existing target always wins.
fn migrate_catalog_dir(source: &Path, target: &Path) -> io::Result<bool> {
    if source == target || target.exists() || !source.is_dir() {
        return Ok(false);
    }
    let parent = target.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "catalog target has no parent")
    })?;
    fs::create_dir_all(parent)?;
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid catalog target"))?;
    let staging = parent.join(format!(".{name}.migrating"));
    fs::create_dir_all(&staging)?;
    merge_missing(source, &staging)?;
    fs::rename(staging, target)?;
    Ok(true)
}

/// Write a secret-bearing file atomically with owner-only permissions on Unix.
/// This is shared by config.toml and persisted endpoint credentials.
pub(crate) fn write_private_file(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("private file has no parent: {}", path.display()))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| format!("private file has no name: {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    harden_private_dir(parent)?;
    // A unique sibling prevents concurrent writers from truncating each
    // other's staging file. `create_new` also closes the residual collision
    // window if a UUID is ever repeated.
    let tmp = parent.join(format!(
        ".{}.{}.{}.tmp",
        file_name.to_string_lossy(),
        std::process::id(),
        uuid::Uuid::now_v7().simple()
    ));

    let result = (|| -> Result<(), String> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options
            .open(&tmp)
            .map_err(|e| format!("create private staging file {}: {e}", tmp.display()))?;
        file.write_all(contents)
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
        file.sync_all()
            .map_err(|e| format!("sync {}: {e}", tmp.display()))?;
        harden_private_file(&tmp)?;
        drop(file);
        replace_file_atomically(&tmp, path)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }
    harden_private_file(path)?;
    if let Ok(dir) = fs::File::open(parent) {
        let _ = dir.sync_all();
    }
    Ok(())
}

#[cfg(not(windows))]
pub(crate) fn replace_file_atomically(staging: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(staging, destination).map_err(|error| {
        format!(
            "atomically replace {} from {}: {error}",
            destination.display(),
            staging.display()
        )
    })
}

#[cfg(windows)]
pub(crate) fn replace_file_atomically(staging: &Path, destination: &Path) -> Result<(), String> {
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let staging_wide = staging
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    // SAFETY: both buffers are NUL-terminated and remain alive for the call.
    let replaced = unsafe {
        MoveFileExW(
            staging_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        Err(format!(
            "atomically replace {} from {}: {}",
            destination.display(),
            staging.display(),
            io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

pub(crate) fn harden_private_file(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("chmod 0600 {}: {e}", path.display()))?;
    }
    Ok(())
}

pub(crate) fn harden_private_dir(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("chmod 0700 {}: {e}", path.display()))?;
    }
    Ok(())
}

fn merge_missing(source: &Path, target: &Path) -> io::Result<()> {
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        if entry.file_name() == LEGACY_AUTH_FILE {
            continue;
        }
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
    use super::{
        catalog_roots, default_workspace_path, merge_missing, migrate_catalog_dir,
        reject_legacy_workbuddy_path, write_private_file,
    };
    use std::fs;
    use std::path::Path;

    #[test]
    fn rejects_legacy_workbuddy_paths_on_both_platforms() {
        assert!(reject_legacy_workbuddy_path(Path::new(
            "/Users/demo/.workbuddy/connectors-marketplace"
        ))
        .is_err());
        assert!(reject_legacy_workbuddy_path(Path::new(
            r"C:\Users\demo\WorkBuddy\connectors-marketplace"
        ))
        .is_err());
    }

    #[test]
    fn allows_similarly_named_non_legacy_paths() {
        assert!(reject_legacy_workbuddy_path(Path::new(
            "/Users/demo/workbuddy-notes/connectors-marketplace"
        ))
        .is_ok());
        assert!(reject_legacy_workbuddy_path(Path::new(
            "/Users/demo/.echo-agent/connectors-marketplace"
        ))
        .is_ok());
    }

    #[test]
    fn catalog_layout_uses_children_of_one_data_home() {
        let root = Path::new("/data/echo-agent-home");
        let catalog = catalog_roots(root);
        assert_eq!(
            catalog.experts,
            Path::new("/data/echo-agent-home/experts-marketplace")
        );
        assert_eq!(
            catalog.connectors,
            Path::new("/data/echo-agent-home/connectors-marketplace")
        );
        assert_eq!(
            catalog.builtin_skills,
            Path::new("/data/echo-agent-home/resources/builtin-skills")
        );
    }

    #[test]
    fn default_workspace_is_a_dedicated_child_not_the_user_home() {
        let user_documents = Path::new("/Users/demo/Documents");
        let workspace = default_workspace_path(user_documents);
        assert_eq!(workspace, user_documents.join("EchoAgent Workspace"));
        assert_ne!(workspace, user_documents);
    }

    #[test]
    fn migration_copies_nested_files_without_overwriting() {
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        fs::create_dir_all(source.path().join("memory/nested")).unwrap();
        fs::create_dir_all(target.path().join("memory")).unwrap();
        fs::write(source.path().join("config.toml"), "legacy").unwrap();
        fs::write(source.path().join("auth.json"), "legacy credentials").unwrap();
        fs::write(source.path().join("memory/MEMORY.md"), "legacy memory").unwrap();
        fs::write(source.path().join("memory/nested/fact.md"), "fact").unwrap();
        fs::write(target.path().join("memory/MEMORY.md"), "current memory").unwrap();

        merge_missing(source.path(), target.path()).unwrap();

        assert_eq!(
            fs::read_to_string(target.path().join("config.toml")).unwrap(),
            "legacy"
        );
        assert!(!target.path().join("auth.json").exists());
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

    #[test]
    fn catalog_migration_is_non_destructive_and_idempotent() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("legacy-experts");
        let target = temp.path().join("data-home").join("experts-marketplace");
        fs::create_dir_all(source.join("_meta")).unwrap();
        fs::write(source.join("_meta/_expert_center.json"), "catalog").unwrap();

        assert!(migrate_catalog_dir(&source, &target).unwrap());
        assert_eq!(
            fs::read_to_string(target.join("_meta/_expert_center.json")).unwrap(),
            "catalog"
        );
        assert!(
            source.exists(),
            "legacy source must remain available for rollback"
        );

        fs::write(source.join("newer.txt"), "must not merge later").unwrap();
        assert!(!migrate_catalog_dir(&source, &target).unwrap());
        assert!(!target.join("newer.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn private_write_creates_and_repairs_owner_only_file() {
        use std::os::unix::fs::PermissionsExt;

        let target = tempfile::tempdir().unwrap();
        let path = target.path().join("secret.json");
        fs::write(&path, "old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

        write_private_file(&path, b"new").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn concurrent_private_writes_never_publish_partial_content() {
        let target = tempfile::tempdir().unwrap();
        let path = target.path().join("config.toml");
        let payloads = (0..12)
            .map(|index| format!("writer-{index}:{}", "x".repeat(32 * 1024)))
            .collect::<Vec<_>>();
        let handles = payloads
            .iter()
            .cloned()
            .map(|payload| {
                let path = path.clone();
                std::thread::spawn(move || write_private_file(&path, payload.as_bytes()).unwrap())
            })
            .collect::<Vec<_>>();
        for handle in handles {
            handle.join().unwrap();
        }

        let written = fs::read_to_string(&path).unwrap();
        assert!(payloads.contains(&written));
        assert_eq!(
            fs::read_dir(target.path())
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
                .count(),
            0
        );
    }
}
