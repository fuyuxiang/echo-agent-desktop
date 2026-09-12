//! File-backed persistence for coding tasks. Mirrors the JSON/JSONL layout
//! already used by `sessions.rs` instead of introducing a database.

use std::path::{Path, PathBuf};

use serde::{de::DeserializeOwned, Serialize};
use sha2::{Digest, Sha256};

/// Per-workspace state root, keyed by a hash of the canonical repository path
/// so two checkouts of the same project never share task state.
pub fn workspace_dir(root: &Path) -> PathBuf {
    let canonical = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let mut hasher = Sha256::new();
    hasher.update(canonical.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    let hash: String = digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    crate::paths::echo_agent_home_dir()
        .join("coding")
        .join(hash)
}

pub fn task_dir(root: &Path, task_id: &str) -> PathBuf {
    workspace_dir(root).join(task_id)
}

pub fn tasks_index_path(root: &Path) -> PathBuf {
    workspace_dir(root).join("tasks.json")
}

/// Paths to the workspace-level cross-file index files introduced in phase 2.
/// They live next to `tasks.json` so they are reachable across all tasks of the
/// same workspace and so an empty state is detected by their absence.
#[derive(Clone, Debug)]
pub struct IndexPaths {
    pub symbols: PathBuf,
    pub refs: PathBuf,
    pub file_index: PathBuf,
}

pub fn index_paths(root: &Path) -> IndexPaths {
    let base = workspace_dir(root);
    IndexPaths {
        symbols: base.join("symbols.jsonl"),
        refs: base.join("refs.jsonl"),
        file_index: base.join("file_index.json"),
    }
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    std::fs::create_dir_all(parent).map_err(|error| format!("无法创建目录：{error}"))
}

/// Read a JSON document, treating a missing or corrupt file as absent so a
/// damaged task file can never crash the workbench.
pub fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    ensure_parent(path)?;
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| format!("序列化失败：{error}"))?;
    std::fs::write(path, bytes).map_err(|error| format!("写入失败：{error}"))
}

pub fn append_jsonl<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    use std::io::Write;
    ensure_parent(path)?;
    let line = serde_json::to_string(value).map_err(|error| format!("序列化失败：{error}"))?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("打开失败：{error}"))?;
    writeln!(file, "{line}").map_err(|error| format!("写入失败：{error}"))
}

/// Read an append-only log, skipping lines that failed to serialize or were
/// truncated by an interrupted write.
pub fn read_jsonl<T: DeserializeOwned>(path: &Path) -> Vec<T> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Serialize, Deserialize, PartialEq, Debug)]
    struct Sample {
        id: String,
        count: u32,
    }

    #[test]
    fn workspace_hash_is_stable_and_path_scoped() {
        let a = workspace_dir(Path::new("/tmp/repo-a"));
        let b = workspace_dir(Path::new("/tmp/repo-b"));
        assert_ne!(a, b);
        assert_eq!(a, workspace_dir(Path::new("/tmp/repo-a")));
    }

    #[test]
    fn json_roundtrip_and_missing_file_is_none() {
        let dir = std::env::temp_dir().join(format!("coding-store-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sample.json");
        assert!(read_json::<Sample>(&path).is_none());
        let value = Sample {
            id: "t1".into(),
            count: 3,
        };
        write_json(&path, &value).unwrap();
        assert_eq!(read_json::<Sample>(&path), Some(value));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn jsonl_appends_in_order_and_skips_corrupt_lines() {
        let dir = std::env::temp_dir().join(format!("coding-store-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("events.jsonl");
        append_jsonl(
            &path,
            &Sample {
                id: "a".into(),
                count: 1,
            },
        )
        .unwrap();
        append_jsonl(
            &path,
            &Sample {
                id: "b".into(),
                count: 2,
            },
        )
        .unwrap();
        std::fs::write(
            &path,
            format!(
                "{}\n{{bad json}}\n",
                std::fs::read_to_string(&path).unwrap().trim()
            ),
        )
        .unwrap();
        let items: Vec<Sample> = read_jsonl(&path);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, "a");
        assert_eq!(items[1].id, "b");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn index_paths_are_workspace_level_and_share_parent_with_workspace_dir() {
        let root = Path::new("/tmp/repo-index");
        let paths = index_paths(root);
        let dir = workspace_dir(root);
        assert_eq!(paths.symbols.parent(), Some(dir.as_path()));
        assert_eq!(paths.refs.parent(), Some(dir.as_path()));
        assert_eq!(paths.file_index.parent(), Some(dir.as_path()));
        assert_eq!(paths.symbols.file_name().unwrap(), "symbols.jsonl");
        assert_eq!(paths.refs.file_name().unwrap(), "refs.jsonl");
        assert_eq!(paths.file_index.file_name().unwrap(), "file_index.json");
    }
}
