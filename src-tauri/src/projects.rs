//! Durable local project metadata.
//!
//! Projects are product state, not renderer cache. Keep the canonical copy in
//! EchoAgent's private data directory and let the frontend retain localStorage
//! only as an offline/migration cache.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;

const MAX_PROJECTS: usize = 500;
const MAX_BYTES: usize = 8 * 1024 * 1024;

static ACCESS: OnceLock<Mutex<()>> = OnceLock::new();

fn access() -> &'static Mutex<()> {
    ACCESS.get_or_init(|| Mutex::new(()))
}

fn store_path() -> PathBuf {
    crate::paths::echo_agent_home_dir().join("echoagent-projects.json")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAssetImport {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub ext: Option<String>,
    pub size_bytes: u64,
    pub updated_at: String,
}

fn validate_project_id(project_id: &str) -> Result<(), String> {
    if project_id.is_empty()
        || project_id.len() > 160
        || !project_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("项目 id 不合法".into());
    }
    Ok(())
}

fn asset_root(project_id: &str) -> Result<PathBuf, String> {
    validate_project_id(project_id)?;
    let root = crate::paths::echo_agent_home_dir()
        .join("projects")
        .join(project_id)
        .join("assets");
    std::fs::create_dir_all(&root).map_err(|error| format!("创建项目资产目录失败：{error}"))?;
    Ok(root)
}

fn available_destination(root: &std::path::Path, name: &str) -> PathBuf {
    let direct = root.join(name);
    if !direct.exists() {
        return direct;
    }
    let path = std::path::Path::new(name);
    let stem = path.file_stem().and_then(|v| v.to_str()).unwrap_or("asset");
    let ext = path.extension().and_then(|v| v.to_str());
    for index in 2..10_000 {
        let candidate = match ext {
            Some(ext) => root.join(format!("{stem} ({index}).{ext}")),
            None => root.join(format!("{stem} ({index})")),
        };
        if !candidate.exists() {
            return candidate;
        }
    }
    root.join(format!("{stem}-{}", chrono::Utc::now().timestamp_millis()))
}

fn asset_from_path(path: &std::path::Path, kind: &str) -> Result<ProjectAssetImport, String> {
    let metadata =
        std::fs::metadata(path).map_err(|error| format!("读取资产元数据失败：{error}"))?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "资产文件名不是有效 UTF-8".to_string())?
        .to_string();
    Ok(ProjectAssetImport {
        ext: path
            .extension()
            .and_then(|value| value.to_str())
            .map(|v| v.to_ascii_uppercase()),
        name,
        path: path.to_string_lossy().to_string(),
        kind: kind.to_string(),
        size_bytes: if metadata.is_file() {
            metadata.len()
        } else {
            0
        },
        updated_at: chrono::Utc::now().to_rfc3339(),
    })
}

fn validate(projects: &[Value]) -> Result<(), String> {
    if projects.len() > MAX_PROJECTS {
        return Err(format!("项目数量不能超过 {MAX_PROJECTS} 个"));
    }
    let mut ids = HashSet::new();
    for project in projects {
        let object = project
            .as_object()
            .ok_or_else(|| "项目数据必须是对象".to_string())?;
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "项目 id 不能为空".to_string())?;
        validate_project_id(id)?;
        let name = object
            .get("name")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| format!("项目 {id} 的名称不能为空"))?;
        if id.len() > 160 || name.chars().count() > 120 {
            return Err(format!("项目 {id} 的 id 或名称过长"));
        }
        if !ids.insert(id.to_string()) {
            return Err(format!("项目 id 重复：{id}"));
        }
    }
    Ok(())
}

fn import_one(
    root: &std::path::Path,
    source: &std::path::Path,
) -> Result<(ProjectAssetImport, PathBuf), String> {
    let metadata = std::fs::symlink_metadata(source)
        .map_err(|error| format!("读取 {} 失败：{error}", source.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("仅支持导入普通文件：{}", source.display()));
    }
    if metadata.len() > 512 * 1024 * 1024 {
        return Err(format!("单个文件不能超过 512 MB：{}", source.display()));
    }
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "源文件名不是有效 UTF-8".to_string())?;
    let destination = available_destination(root, name);
    if let Err(error) = std::fs::copy(source, &destination) {
        let _ = std::fs::remove_file(&destination);
        return Err(format!("导入 {} 失败：{error}", source.display()));
    }
    if let Err(error) = crate::paths::harden_private_file(&destination) {
        let _ = std::fs::remove_file(&destination);
        return Err(error);
    }
    match asset_from_path(&destination, "file") {
        Ok(asset) => Ok((asset, destination)),
        Err(error) => {
            let _ = std::fs::remove_file(&destination);
            Err(error)
        }
    }
}

fn import_files(
    root: &std::path::Path,
    sources: &[PathBuf],
) -> Result<Vec<ProjectAssetImport>, String> {
    let mut imported = Vec::with_capacity(sources.len());
    let mut copied = Vec::with_capacity(sources.len());
    for source in sources {
        match import_one(root, source) {
            Ok((asset, destination)) => {
                imported.push(asset);
                copied.push(destination);
            }
            Err(error) => {
                for destination in copied {
                    let _ = std::fs::remove_file(destination);
                }
                return Err(error);
            }
        }
    }
    Ok(imported)
}

fn read_from(path: &std::path::Path) -> Result<Vec<Value>, String> {
    let raw = match std::fs::read(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("读取项目数据失败：{error}")),
    };
    if raw.len() > MAX_BYTES {
        return Err("项目数据文件超过 8 MB 安全上限".into());
    }
    let projects: Vec<Value> =
        serde_json::from_slice(&raw).map_err(|error| format!("解析项目数据失败：{error}"))?;
    validate(&projects)?;
    Ok(projects)
}

fn write_to(path: &std::path::Path, projects: &[Value]) -> Result<(), String> {
    validate(projects)?;
    let raw = serde_json::to_vec_pretty(projects)
        .map_err(|error| format!("序列化项目数据失败：{error}"))?;
    if raw.len() > MAX_BYTES {
        return Err("项目数据超过 8 MB 安全上限".into());
    }
    crate::paths::write_private_file(path, &raw)
}

#[tauri::command]
pub fn projects_load() -> Result<Vec<Value>, String> {
    let _guard = access()
        .lock()
        .map_err(|_| "项目存储锁已损坏".to_string())?;
    read_from(&store_path())
}

#[tauri::command]
pub fn projects_save(projects: Vec<Value>) -> Result<(), String> {
    let _guard = access()
        .lock()
        .map_err(|_| "项目存储锁已损坏".to_string())?;
    write_to(&store_path(), &projects)
}

/// Copy files explicitly selected by the user into this project's private
/// asset directory. Sources are never moved or modified.
#[tauri::command]
pub fn project_assets_import(
    project_id: String,
    sources: Vec<String>,
) -> Result<Vec<ProjectAssetImport>, String> {
    if sources.is_empty() {
        return Ok(Vec::new());
    }
    if sources.len() > 100 {
        return Err("单次最多导入 100 个文件".into());
    }
    let root = asset_root(&project_id)?;
    let sources = sources.into_iter().map(PathBuf::from).collect::<Vec<_>>();
    import_files(&root, &sources)
}

#[tauri::command]
pub fn project_asset_make_dir(
    project_id: String,
    name: String,
) -> Result<ProjectAssetImport, String> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err("文件夹名称不合法".into());
    }
    let root = asset_root(&project_id)?;
    let destination = available_destination(&root, name);
    std::fs::create_dir(&destination).map_err(|error| format!("创建文件夹失败：{error}"))?;
    asset_from_path(&destination, "folder")
}

#[tauri::command]
pub fn project_asset_remove(project_id: String, path: String) -> Result<(), String> {
    let root = asset_root(&project_id)?
        .canonicalize()
        .map_err(|error| format!("解析资产目录失败：{error}"))?;
    let target = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| format!("解析资产路径失败：{error}"))?;
    if target == root || !target.starts_with(&root) {
        return Err("拒绝删除项目资产目录之外的路径".into());
    }
    let metadata =
        std::fs::symlink_metadata(&target).map_err(|error| format!("读取资产失败：{error}"))?;
    if metadata.is_file() {
        std::fs::remove_file(&target).map_err(|error| format!("删除文件失败：{error}"))
    } else if metadata.is_dir() {
        std::fs::remove_dir(&target).map_err(|error| format!("删除文件夹失败（必须为空）：{error}"))
    } else {
        Err("不支持删除该类型资产".into())
    }
}

/// Remove the private asset copies owned by a project. Original source files
/// and EchoAgent conversations are outside this directory and remain intact.
#[tauri::command]
pub fn project_assets_remove_all(project_id: String) -> Result<(), String> {
    validate_project_id(&project_id)?;
    let projects_root = crate::paths::echo_agent_home_dir().join("projects");
    let project_root = projects_root.join(&project_id);
    if !project_root.exists() {
        return Ok(());
    }
    let metadata = std::fs::symlink_metadata(&project_root)
        .map_err(|error| format!("读取待删除项目目录失败：{error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("拒绝删除符号链接或非目录的项目路径".into());
    }
    let canonical_projects = projects_root
        .canonicalize()
        .map_err(|error| format!("解析项目目录失败：{error}"))?;
    let canonical_project = project_root
        .canonicalize()
        .map_err(|error| format!("解析待删除项目目录失败：{error}"))?;
    if canonical_project == canonical_projects
        || !canonical_project.starts_with(&canonical_projects)
    {
        return Err("拒绝删除项目数据目录之外的路径".into());
    }
    std::fs::remove_dir_all(&canonical_project)
        .map_err(|error| format!("删除项目资产副本失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::{available_destination, import_files, read_from, validate, write_to};
    use serde_json::json;

    #[test]
    fn project_store_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("projects.json");
        let projects = vec![json!({
            "id": "p1",
            "name": "交付项目",
            "instructions": "优先保证可回归",
            "conversations": []
        })];
        write_to(&path, &projects).unwrap();
        assert_eq!(read_from(&path).unwrap(), projects);
    }

    #[test]
    fn project_store_rejects_duplicate_ids() {
        let projects = vec![
            json!({"id": "p1", "name": "A"}),
            json!({"id": "p1", "name": "B"}),
        ];
        assert!(validate(&projects).unwrap_err().contains("重复"));
    }

    #[test]
    fn missing_project_store_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_from(&dir.path().join("missing.json"))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn duplicate_asset_names_get_a_stable_suffix() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("report.pdf"), "one").unwrap();
        assert_eq!(
            available_destination(dir.path(), "report.pdf")
                .file_name()
                .unwrap(),
            "report (2).pdf"
        );
    }

    #[test]
    fn failed_batch_import_rolls_back_already_copied_files() {
        let source_dir = tempfile::tempdir().unwrap();
        let asset_dir = tempfile::tempdir().unwrap();
        let valid = source_dir.path().join("valid.txt");
        std::fs::write(&valid, "content").unwrap();
        let missing = source_dir.path().join("missing.txt");
        let error = import_files(asset_dir.path(), &[valid, missing]).unwrap_err();
        assert!(error.contains("读取"));
        assert_eq!(std::fs::read_dir(asset_dir.path()).unwrap().count(), 0);
    }
}
