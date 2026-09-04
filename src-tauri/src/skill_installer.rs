//! Managed local Skill packages.
//!
//! The upstream runtime deliberately treats Skills as filesystem content.  That
//! is excellent for development, but a desktop product also needs an installer:
//! validate first, safely unpack archives, keep an owned copy, surface risk, and
//! update/uninstall atomically.  This module owns only packages under
//! `~/.echo-agent/skills`; external/project/plugin Skills remain runtime-owned.

use std::collections::HashSet;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;
use uuid::Uuid;

const INSTALL_MANIFEST: &str = ".echo-agent-install.json";
const MAX_FILES: usize = 200;
const MAX_TOTAL_BYTES: u64 = 20 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_DEPTH: usize = 12;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum SkillRiskLevel {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillRiskFinding {
    pub level: SkillRiskLevel,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPackageInspection {
    pub source_path: String,
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub file_count: usize,
    pub total_bytes: u64,
    pub risk_level: SkillRiskLevel,
    pub findings: Vec<SkillRiskFinding>,
    pub warnings: Vec<String>,
    pub source_hash: String,
    pub already_installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallResult {
    pub installed_path: String,
    pub updated: bool,
    pub inspection: SkillPackageInspection,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallManifest {
    schema_version: u32,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    source_path: String,
    source_hash: String,
    installed_at: String,
    risk_level: SkillRiskLevel,
    findings: Vec<SkillRiskFinding>,
}

struct PreparedPackage {
    root: PathBuf,
    cleanup_root: Option<PathBuf>,
    source_path: String,
}

impl Drop for PreparedPackage {
    fn drop(&mut self) {
        if let Some(path) = self.cleanup_root.take() {
            let _ = fs::remove_dir_all(path);
        }
    }
}

#[derive(Debug)]
struct PackageFile {
    absolute: PathBuf,
    relative: PathBuf,
    size: u64,
}

fn require_authorized_package(
    access: &crate::shell_fs::FilesystemAccess,
    raw: &str,
) -> Result<String, String> {
    let canonical = if let Some(managed) = canonical_managed_skill_directory(raw) {
        managed
    } else if let Some(managed) = crate::org::canonical_org_managed_skill_directory(raw) {
        managed
    } else {
        access.require_authorized_package_source(Path::new(raw))?
    };
    Ok(canonical.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn skills_inspect_package(
    access: State<'_, crate::shell_fs::FilesystemAccess>,
    path: String,
) -> Result<SkillPackageInspection, String> {
    let path = require_authorized_package(&access, &path)?;
    tauri::async_runtime::spawn_blocking(move || inspect_path(&path))
        .await
        .map_err(|error| format!("检查技能包失败：{error}"))?
}

#[tauri::command]
pub async fn skills_install_package(
    access: State<'_, crate::shell_fs::FilesystemAccess>,
    path: String,
    expected_source_hash: String,
    approve_high_risk: bool,
) -> Result<SkillInstallResult, String> {
    crate::policy::require_feature("skills")?;
    crate::policy::require_skill_upload()?;
    let path = require_authorized_package(&access, &path)?;
    tauri::async_runtime::spawn_blocking(move || {
        install_path(&path, &expected_source_hash, approve_high_risk)
    })
    .await
    .map_err(|error| format!("安装技能包失败：{error}"))?
}

#[tauri::command]
pub async fn skills_uninstall_package(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || uninstall_path(&path))
        .await
        .map_err(|error| format!("卸载技能包失败：{error}"))?
}

/// Build the ZIP accepted by echo-agent-server from any local Skill path.
///
/// The same parser and file-safety limits as the local installer are used, so
/// a row from the Skills page can upload its directory or SKILL.md directly;
/// the frontend never needs to create a temporary archive itself.
pub(crate) fn package_skill_for_upload(path: &str) -> Result<(String, Vec<u8>), String> {
    let requested = Path::new(path);
    // Runtime listings normally point at SKILL.md. In that case upload the
    // complete Skill directory so references/, scripts/, and assets are not
    // silently dropped. An arbitrary Markdown file remains a single-file Skill.
    let source = if requested.file_name().and_then(|name| name.to_str()) == Some("SKILL.md") {
        requested.parent().unwrap_or(requested)
    } else {
        requested
    };
    let prepared = prepare_package(source)?;
    let inspection = inspect_prepared(&prepared)?;
    let files = collect_package_files(&prepared.root)?;
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);
    for file in files {
        let relative = file
            .relative
            .components()
            .map(|component| component.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        writer
            .start_file(&relative, options)
            .map_err(|error| format!("创建 Skill ZIP 条目失败：{error}"))?;
        let bytes = crate::shell_fs::read_regular_file_bounded(&file.absolute, file.size)
            .map_err(|error| format!("读取技能文件失败：{error}"))?;
        writer
            .write_all(&bytes)
            .map_err(|error| format!("写入 Skill ZIP 失败：{error}"))?;
    }
    let bytes = writer
        .finish()
        .map_err(|error| format!("完成 Skill ZIP 失败：{error}"))?
        .into_inner();
    Ok((format!("{}.zip", slugify(&inspection.name)), bytes))
}

pub fn is_managed_skill(path: &str) -> bool {
    canonical_managed_skill_directory(path).is_some()
}

pub(crate) fn canonical_managed_skill_directory(path: &str) -> Option<PathBuf> {
    let root = managed_skills_root().canonicalize().ok()?;
    let candidate = skill_directory(Path::new(path)).canonicalize().ok()?;
    if candidate.parent() != Some(root.as_path()) {
        return None;
    }
    let manifest = candidate.join(INSTALL_MANIFEST);
    let metadata = fs::symlink_metadata(manifest).ok()?;
    (!metadata.file_type().is_symlink() && metadata.is_file()).then_some(candidate)
}

pub fn managed_skill_version(path: &str) -> Option<String> {
    let manifest = read_manifest(&canonical_managed_skill_directory(path)?)?;
    manifest.version
}

pub fn managed_skill_directory(path: &str) -> Option<String> {
    canonical_managed_skill_directory(path)
        .map(|directory| directory.to_string_lossy().into_owned())
}

/// Validate an external path before registering it in `[skills].paths`.
/// Registration intentionally supports a directory containing multiple Skills
/// (connector bundles); ZIP packages must go through the managed installer.
pub fn validate_registered_source(path: &str) -> Result<(), String> {
    let input = Path::new(path);
    let metadata = fs::symlink_metadata(input).map_err(|e| format!("技能路径不可读：{e}"))?;
    if metadata.file_type().is_symlink() {
        return Err("技能路径不能是符号链接".into());
    }
    if metadata.is_file()
        && input
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("zip"))
    {
        return Err("ZIP 技能包请使用「安装本地技能」流程".into());
    }
    if metadata.is_file()
        && !input
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
    {
        return Err("单文件技能必须是 Markdown 文件".into());
    }
    let mut hits = Vec::new();
    if metadata.is_dir() {
        find_skill_files(input, input, 0, &mut hits)?;
    } else if metadata.is_file() {
        hits.push(input.to_path_buf());
    } else {
        return Err("不支持的技能路径类型".into());
    }
    if hits.is_empty() {
        return Err("所选路径下未找到 SKILL.md".into());
    }
    if hits.len() > MAX_FILES {
        return Err(format!("一次最多注册 {MAX_FILES} 个技能"));
    }
    for hit in hits {
        let markdown = read_skill_text(&hit, MAX_FILE_BYTES)
            .map_err(|e| format!("{} 必须是 UTF-8 Markdown：{e}", hit.display()))?;
        let root = hit.parent().unwrap_or(input);
        parse_skill_metadata(&markdown, root)?;
    }
    Ok(())
}

fn skill_directory(path: &Path) -> PathBuf {
    if path.file_name().and_then(|name| name.to_str()) == Some("SKILL.md") {
        path.parent().unwrap_or(path).to_path_buf()
    } else {
        path.to_path_buf()
    }
}

fn inspect_path(path: &str) -> Result<SkillPackageInspection, String> {
    let prepared = prepare_package(Path::new(path))?;
    inspect_prepared(&prepared)
}

fn install_path(
    path: &str,
    expected_source_hash: &str,
    approve_high_risk: bool,
) -> Result<SkillInstallResult, String> {
    let prepared = prepare_package(Path::new(path))?;
    let inspection = inspect_prepared(&prepared)?;
    require_matching_source_hash(expected_source_hash, &inspection.source_hash)?;
    if inspection.risk_level == SkillRiskLevel::High && !approve_high_risk {
        return Err("该技能包包含高风险内容，请先查看风险报告并明确确认".into());
    }
    install_prepared(&prepared, inspection, &managed_skills_root())
}

fn require_matching_source_hash(expected: &str, actual: &str) -> Result<(), String> {
    if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("安装请求缺少有效的技能包内容指纹，请重新检查".into());
    }
    // Inspection and installation are separate IPC calls. Bind the user's
    // approval to the exact inspected bytes so a file watcher, sync client or
    // attacker cannot replace a benign package between those two actions.
    if actual != expected {
        return Err("技能包在检查后已发生变化，请重新查看风险报告再安装".into());
    }
    Ok(())
}

fn install_prepared(
    prepared: &PreparedPackage,
    mut inspection: SkillPackageInspection,
    root: &Path,
) -> Result<SkillInstallResult, String> {
    fs::create_dir_all(root).map_err(|e| format!("创建本地技能目录失败：{e}"))?;
    let existing = find_managed_by_name_in(root, &inspection.name);
    let target = existing
        .clone()
        .unwrap_or_else(|| allocate_target(root, &slugify(&inspection.name)));
    let updated = existing.is_some();

    let stage = root.join(format!(".install-{}", Uuid::now_v7()));
    if let Err(error) = copy_package(&prepared.root, &stage) {
        let _ = fs::remove_dir_all(&stage);
        return Err(error);
    }
    let manifest = InstallManifest {
        schema_version: 1,
        name: inspection.name.clone(),
        version: inspection.version.clone(),
        source_path: prepared.source_path.clone(),
        source_hash: inspection.source_hash.clone(),
        installed_at: Utc::now().to_rfc3339(),
        risk_level: inspection.risk_level,
        findings: inspection.findings.clone(),
    };
    let manifest_bytes =
        serde_json::to_vec_pretty(&manifest).map_err(|e| format!("生成技能安装信息失败：{e}"))?;
    if let Err(error) = fs::write(stage.join(INSTALL_MANIFEST), manifest_bytes) {
        let _ = fs::remove_dir_all(&stage);
        return Err(format!("写入技能安装信息失败：{error}"));
    }

    let backup = root.join(format!(".backup-{}", Uuid::now_v7()));
    if target.exists() {
        if !target.join(INSTALL_MANIFEST).is_file() {
            let _ = fs::remove_dir_all(&stage);
            return Err(format!(
                "目标目录已存在且不受 EchoAgent 管理：{}",
                target.display()
            ));
        }
        fs::rename(&target, &backup).map_err(|e| format!("备份旧版技能失败：{e}"))?;
    }
    if let Err(error) = fs::rename(&stage, &target) {
        if backup.exists() {
            let _ = fs::rename(&backup, &target);
        }
        let _ = fs::remove_dir_all(&stage);
        return Err(format!("激活技能失败：{error}"));
    }
    if backup.exists() {
        let _ = fs::remove_dir_all(&backup);
    }

    inspection.already_installed = true;
    inspection.installed_path = Some(target.to_string_lossy().into_owned());
    Ok(SkillInstallResult {
        installed_path: target.to_string_lossy().into_owned(),
        updated,
        inspection,
    })
}

fn uninstall_path(path: &str) -> Result<(), String> {
    let root = managed_skills_root();
    uninstall_path_in(Path::new(path), &root, true)
}

fn uninstall_path_in(requested: &Path, root: &Path, clear_config: bool) -> Result<(), String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("本地技能目录不存在：{e}"))?;
    let canonical = requested
        .canonicalize()
        .map_err(|e| format!("技能目录不存在：{e}"))?;
    if canonical.parent() != Some(canonical_root.as_path())
        || !canonical.join(INSTALL_MANIFEST).is_file()
    {
        return Err("只能卸载由 EchoAgent 安装管理的本地技能".into());
    }
    let name = read_manifest(&canonical).map(|m| m.name);
    // Persist the enable/disable cleanup first. If that write fails, keep the
    // installed package intact instead of leaving configuration half-updated.
    if clear_config {
        if let Some(name) = name.as_deref() {
            clear_disabled_skill(name)?;
        }
    }
    let trash = canonical_root.join(format!(".uninstall-{}", Uuid::now_v7()));
    fs::rename(&canonical, &trash).map_err(|e| format!("移出技能目录失败：{e}"))?;
    if let Err(error) = fs::remove_dir_all(&trash) {
        let _ = fs::rename(&trash, &canonical);
        return Err(format!("删除技能目录失败：{error}"));
    }
    Ok(())
}

fn prepare_package(input: &Path) -> Result<PreparedPackage, String> {
    let meta = fs::symlink_metadata(input)
        .map_err(|e| format!("无法读取所选路径 {}: {e}", input.display()))?;
    if meta.file_type().is_symlink() {
        return Err("技能来源不能是符号链接".into());
    }
    let source_path = input
        .canonicalize()
        .unwrap_or_else(|_| input.to_path_buf())
        .to_string_lossy()
        .into_owned();
    if meta.is_dir() {
        let root = locate_skill_root(input)?;
        // Work from an owned snapshot. Otherwise a directory could change
        // after risk inspection but before hashing/installing or uploading.
        let temp = staging_root().join(Uuid::now_v7().to_string());
        if let Err(error) = copy_package(&root, &temp) {
            let _ = fs::remove_dir_all(&temp);
            return Err(error);
        }
        return Ok(PreparedPackage {
            root: temp.clone(),
            cleanup_root: Some(temp),
            source_path,
        });
    }
    if !meta.is_file() {
        return Err("仅支持技能文件夹、Markdown 文件或 ZIP 压缩包".into());
    }
    let ext = input
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match ext.as_str() {
        "zip" => prepare_zip(input, source_path),
        "md" | "markdown" => {
            if meta.len() > MAX_FILE_BYTES {
                return Err("技能 Markdown 文件超过 8MB 限制".into());
            }
            let temp = staging_root().join(Uuid::now_v7().to_string());
            fs::create_dir_all(&temp).map_err(|e| format!("创建技能临时目录失败：{e}"))?;
            let copy_result = crate::shell_fs::read_regular_file_bounded(input, MAX_FILE_BYTES)
                .and_then(|bytes| {
                    fs::write(temp.join("SKILL.md"), bytes)
                        .map_err(|error| format!("写入技能快照失败：{error}"))
                });
            if let Err(error) = copy_result {
                let _ = fs::remove_dir_all(&temp);
                return Err(format!("复制技能文件失败：{error}"));
            }
            Ok(PreparedPackage {
                root: temp.clone(),
                cleanup_root: Some(temp),
                source_path,
            })
        }
        _ => Err("不支持的技能包格式，请选择文件夹、.md 或 .zip".into()),
    }
}

fn prepare_zip(input: &Path, source_path: String) -> Result<PreparedPackage, String> {
    let compressed = crate::shell_fs::read_regular_file_bounded(input, MAX_TOTAL_BYTES)
        .map_err(|error| format!("读取 ZIP 失败：{error}"))?;
    let temp = staging_root().join(Uuid::now_v7().to_string());
    fs::create_dir_all(&temp).map_err(|e| format!("创建解压目录失败：{e}"))?;
    let result = (|| -> Result<PathBuf, String> {
        let mut archive = zip::ZipArchive::new(Cursor::new(compressed))
            .map_err(|e| format!("无效的 ZIP 压缩包：{e}"))?;
        if archive.len() > MAX_FILES {
            return Err(format!("ZIP 文件数超过 {MAX_FILES} 个限制"));
        }
        let mut total = 0u64;
        let mut seen = HashSet::new();
        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|e| format!("读取 ZIP 条目失败：{e}"))?;
            if entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
            {
                return Err("ZIP 中不允许符号链接".into());
            }
            let relative = entry
                .enclosed_name()
                .ok_or("ZIP 中包含不安全的路径")?
                .to_path_buf();
            validate_relative_path(&relative)?;
            let folded = relative.to_string_lossy().to_lowercase();
            if !seen.insert(folded) {
                return Err(format!("ZIP 中包含重复路径：{}", relative.display()));
            }
            total = total.saturating_add(entry.size());
            if entry.size() > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES {
                return Err("技能包解压后超过安全大小限制".into());
            }
            let target = temp.join(&relative);
            if entry.is_dir() {
                fs::create_dir_all(&target).map_err(|e| format!("创建解压目录失败：{e}"))?;
                continue;
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("创建解压目录失败：{e}"))?;
            }
            let mut output =
                fs::File::create(&target).map_err(|e| format!("创建解压文件失败：{e}"))?;
            let copied = std::io::copy(&mut entry.by_ref().take(MAX_FILE_BYTES + 1), &mut output)
                .map_err(|e| format!("解压文件失败：{e}"))?;
            if copied > MAX_FILE_BYTES || copied != entry.size() {
                return Err(format!("ZIP 条目实际大小异常：{}", relative.display()));
            }
            output
                .flush()
                .map_err(|e| format!("写入解压文件失败：{e}"))?;
        }
        locate_skill_root(&temp)
    })();
    match result {
        Ok(root) => Ok(PreparedPackage {
            root,
            cleanup_root: Some(temp),
            source_path,
        }),
        Err(error) => {
            let _ = fs::remove_dir_all(&temp);
            Err(error)
        }
    }
}

fn inspect_prepared(prepared: &PreparedPackage) -> Result<SkillPackageInspection, String> {
    let files = collect_package_files(&prepared.root)?;
    let skill_file = files
        .iter()
        .find(|f| f.relative.file_name().and_then(|n| n.to_str()) == Some("SKILL.md"))
        .ok_or("技能包缺少 SKILL.md")?;
    let markdown = read_skill_text(&skill_file.absolute, MAX_FILE_BYTES)
        .map_err(|e| format!("SKILL.md 必须是 UTF-8 文本：{e}"))?;
    let (name, description, version, mut warnings) =
        parse_skill_metadata(&markdown, &prepared.root)?;
    let (risk_level, findings) = scan_risk(&files)?;
    if findings.is_empty() {
        warnings.push("静态检查未发现明显风险；技能仍可能指导 Agent 执行外部操作".into());
    }
    let total_bytes = files.iter().map(|f| f.size).sum();
    let source_hash = package_hash(&files)?;
    let installed = find_managed_by_name(&name);
    Ok(SkillPackageInspection {
        source_path: prepared.source_path.clone(),
        name,
        description,
        version,
        file_count: files.len(),
        total_bytes,
        risk_level,
        findings,
        warnings,
        source_hash,
        already_installed: installed.is_some(),
        installed_path: installed.map(|p| p.to_string_lossy().into_owned()),
    })
}

fn locate_skill_root(root: &Path) -> Result<PathBuf, String> {
    let mut hits = Vec::new();
    find_skill_files(root, root, 0, &mut hits)?;
    match hits.as_slice() {
        [] => Err("未找到 SKILL.md".into()),
        [only] => Ok(only.parent().unwrap_or(root).to_path_buf()),
        _ => Err("一次只能安装一个技能，所选内容包含多个 SKILL.md".into()),
    }
}

fn find_skill_files(
    base: &Path,
    dir: &Path,
    depth: usize,
    hits: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return Err(format!("技能目录嵌套超过 {MAX_DEPTH} 层"));
    }
    for entry in fs::read_dir(dir).map_err(|e| format!("读取技能目录失败：{e}"))? {
        let entry = entry.map_err(|e| format!("读取技能目录失败：{e}"))?;
        let path = entry.path();
        let meta = fs::symlink_metadata(&path).map_err(|e| format!("读取技能文件失败：{e}"))?;
        if meta.file_type().is_symlink() {
            return Err(format!("技能包不允许符号链接：{}", path.display()));
        }
        if meta.is_dir() {
            if ignored_dir(&path) {
                continue;
            }
            find_skill_files(base, &path, depth + 1, hits)?;
        } else if meta.is_file() && entry.file_name() == "SKILL.md" {
            let relative = path.strip_prefix(base).map_err(|_| "技能文件超出根目录")?;
            validate_relative_path(relative)?;
            hits.push(path);
        }
    }
    Ok(())
}

fn collect_package_files(root: &Path) -> Result<Vec<PackageFile>, String> {
    let mut out = Vec::new();
    collect_files_rec(root, root, 0, &mut out)?;
    if out.is_empty() {
        return Err("技能包为空".into());
    }
    if out.len() > MAX_FILES {
        return Err(format!("技能包文件数超过 {MAX_FILES} 个限制"));
    }
    let total: u64 = out.iter().map(|f| f.size).sum();
    if total > MAX_TOTAL_BYTES {
        return Err("技能包超过 20MB 限制".into());
    }
    out.sort_by(|a, b| a.relative.cmp(&b.relative));
    Ok(out)
}

fn collect_files_rec(
    root: &Path,
    dir: &Path,
    depth: usize,
    out: &mut Vec<PackageFile>,
) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return Err(format!("技能目录嵌套超过 {MAX_DEPTH} 层"));
    }
    for entry in fs::read_dir(dir).map_err(|e| format!("读取技能目录失败：{e}"))? {
        let entry = entry.map_err(|e| format!("读取技能目录失败：{e}"))?;
        let path = entry.path();
        let meta = fs::symlink_metadata(&path).map_err(|e| format!("读取技能文件失败：{e}"))?;
        if meta.file_type().is_symlink() {
            return Err(format!("技能包不允许符号链接：{}", path.display()));
        }
        if meta.is_dir() {
            if ignored_dir(&path) {
                continue;
            }
            collect_files_rec(root, &path, depth + 1, out)?;
        } else if meta.is_file() {
            if path.file_name().and_then(|name| name.to_str()) == Some(INSTALL_MANIFEST) {
                continue;
            }
            if out.len() >= MAX_FILES {
                return Err(format!("技能包文件数超过 {MAX_FILES} 个限制"));
            }
            if meta.len() > MAX_FILE_BYTES {
                return Err(format!("单个技能文件超过 8MB：{}", path.display()));
            }
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "技能文件超出根目录")?
                .to_path_buf();
            validate_relative_path(&relative)?;
            out.push(PackageFile {
                absolute: path,
                relative,
                size: meta.len(),
            });
        } else {
            return Err("技能包包含不支持的文件类型".into());
        }
    }
    Ok(())
}

fn parse_skill_metadata(
    markdown: &str,
    root: &Path,
) -> Result<(String, String, Option<String>, Vec<String>), String> {
    if markdown.trim().is_empty() {
        return Err("SKILL.md 不能为空".into());
    }
    let mut warnings = Vec::new();
    let frontmatter = extract_frontmatter(markdown);
    let fallback_name = root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("local-skill")
        .to_string();
    let declared_name = frontmatter
        .and_then(|fm| parse_scalar(fm, "name").or_else(|| parse_scalar(fm, "slug")))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            warnings.push("SKILL.md 缺少 name/slug，已使用目录名".into());
            fallback_name
        });
    validate_skill_name(&declared_name)?;
    let name = runtime_skill_slug(&declared_name);
    if name != declared_name {
        warnings.push(format!(
            "技能标识「{declared_name}」已规范化为 Runtime 可用名称「{name}」"
        ));
    }
    let description = frontmatter
        .and_then(|fm| {
            parse_scalar(fm, "description_zh").or_else(|| parse_scalar(fm, "description"))
        })
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            warnings.push("SKILL.md 缺少 description，建议补充适用场景和边界".into());
            first_body_paragraph(markdown).unwrap_or_else(|| "本地技能".into())
        });
    let version = frontmatter.and_then(|fm| parse_scalar(fm, "version"));
    if frontmatter.is_none() {
        warnings.push("SKILL.md 没有 YAML frontmatter，可以运行但元数据不完整".into());
    }
    Ok((
        name.trim().to_string(),
        description.trim().to_string(),
        version,
        warnings,
    ))
}

fn extract_frontmatter(text: &str) -> Option<&str> {
    let text = text.trim_start();
    let rest = text.strip_prefix("---")?;
    let rest = rest
        .strip_prefix("\r\n")
        .or_else(|| rest.strip_prefix('\n'))?;
    let mut offset = 0usize;
    for line in rest.split_inclusive('\n') {
        if line.trim() == "---" {
            return Some(&rest[..offset]);
        }
        offset += line.len();
    }
    None
}

fn parse_scalar(frontmatter: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}:");
    for line in frontmatter.lines() {
        if line.len() == line.trim_start().len() && line.starts_with(&prefix) {
            let value = line[prefix.len()..].trim();
            if value.is_empty() || matches!(value, "|" | "|-" | ">" | ">-") {
                return None;
            }
            return Some(value.trim_matches(['\'', '"']).trim().to_string());
        }
    }
    None
}

fn first_body_paragraph(markdown: &str) -> Option<String> {
    markdown
        .lines()
        .map(str::trim)
        .find(|line| {
            !line.is_empty() && !line.starts_with('#') && *line != "---" && !line.contains(": ")
        })
        .map(|line| line.chars().take(240).collect())
}

fn scan_risk(files: &[PackageFile]) -> Result<(SkillRiskLevel, Vec<SkillRiskFinding>), String> {
    let mut findings = Vec::new();
    let script_exts = [
        "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "py", "js", "mjs", "cjs", "ts",
    ];
    let binary_exts = ["exe", "dll", "dylib", "so", "jar", "app", "msi"];
    let high_patterns = [
        ("rm -rf", "destructive-command", "包含递归强制删除命令"),
        ("sudo ", "privilege-escalation", "要求管理员权限"),
        ("curl | sh", "remote-execution", "下载并直接执行远程脚本"),
        ("curl|sh", "remote-execution", "下载并直接执行远程脚本"),
        ("wget | sh", "remote-execution", "下载并直接执行远程脚本"),
        (".ssh/", "sensitive-files", "访问 SSH 敏感目录"),
        ("id_rsa", "sensitive-files", "访问 SSH 私钥"),
        (
            "security find-generic-password",
            "credential-access",
            "访问系统密钥串",
        ),
        (
            "powershell -enc",
            "encoded-execution",
            "执行编码的 PowerShell 命令",
        ),
    ];
    let medium_patterns = [
        ("curl ", "network-access", "使用 curl 访问网络"),
        ("wget ", "network-access", "使用 wget 访问网络"),
        ("pip install", "dependency-install", "安装 Python 依赖"),
        ("npm install", "dependency-install", "安装 Node.js 依赖"),
        ("npx ", "package-execution", "执行 npm 包"),
        ("brew install", "dependency-install", "安装系统依赖"),
        ("apt install", "dependency-install", "安装系统依赖"),
        ("subprocess", "process-execution", "创建子进程"),
        ("child_process", "process-execution", "创建子进程"),
    ];
    let mut dedupe = HashSet::new();
    for file in files {
        let relative = file.relative.to_string_lossy().into_owned();
        let ext = file
            .relative
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if binary_exts.contains(&ext.as_str()) {
            add_finding(
                &mut findings,
                &mut dedupe,
                SkillRiskLevel::High,
                "executable-binary",
                "包含可执行文件或动态库",
                &relative,
            );
        } else if script_exts.contains(&ext.as_str()) {
            add_finding(
                &mut findings,
                &mut dedupe,
                SkillRiskLevel::Medium,
                "executable-script",
                "包含可执行脚本，安装前应审查源码",
                &relative,
            );
        }
        if file.size > 1024 * 1024 {
            continue;
        }
        let bytes = crate::shell_fs::read_regular_file_bounded(&file.absolute, 1024 * 1024)
            .map_err(|e| format!("读取技能文件失败：{e}"))?;
        let Ok(text) = String::from_utf8(bytes) else {
            continue;
        };
        let lower = text.to_lowercase();
        for (pattern, code, message) in high_patterns {
            if lower.contains(pattern) {
                add_finding(
                    &mut findings,
                    &mut dedupe,
                    SkillRiskLevel::High,
                    code,
                    message,
                    &relative,
                );
            }
        }
        for (pattern, code, message) in medium_patterns {
            if lower.contains(pattern) {
                add_finding(
                    &mut findings,
                    &mut dedupe,
                    SkillRiskLevel::Medium,
                    code,
                    message,
                    &relative,
                );
            }
        }
    }
    let risk = findings
        .iter()
        .map(|f| f.level)
        .max()
        .unwrap_or(SkillRiskLevel::Low);
    Ok((risk, findings))
}

fn add_finding(
    findings: &mut Vec<SkillRiskFinding>,
    dedupe: &mut HashSet<String>,
    level: SkillRiskLevel,
    code: &str,
    message: &str,
    path: &str,
) {
    let key = format!("{code}:{path}");
    if dedupe.insert(key) && findings.len() < 50 {
        findings.push(SkillRiskFinding {
            level,
            code: code.into(),
            message: message.into(),
            path: Some(path.into()),
        });
    }
}

fn read_skill_text(path: &Path, max_bytes: u64) -> Result<String, String> {
    let bytes = crate::shell_fs::read_regular_file_bounded(path, max_bytes)?;
    String::from_utf8(bytes).map_err(|error| error.to_string())
}

fn package_hash(files: &[PackageFile]) -> Result<String, String> {
    let mut hasher = Sha256::new();
    for file in files {
        hasher.update(file.relative.to_string_lossy().as_bytes());
        hasher.update([0]);
        let bytes = crate::shell_fs::read_regular_file_bounded(&file.absolute, file.size)
            .map_err(|e| format!("读取技能文件失败：{e}"))?;
        hasher.update(bytes);
        hasher.update([0xff]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn copy_package(source: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        return Err("技能安装临时目录已存在".into());
    }
    fs::create_dir_all(target).map_err(|e| format!("创建技能安装目录失败：{e}"))?;
    let files = collect_package_files(source)?;
    for file in files {
        let destination = target.join(&file.relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建技能子目录失败：{e}"))?;
        }
        let bytes = crate::shell_fs::read_regular_file_bounded(&file.absolute, file.size)
            .map_err(|e| format!("读取技能文件 {} 失败：{e}", file.relative.display()))?;
        let permissions = fs::metadata(&file.absolute)
            .ok()
            .map(|meta| meta.permissions());
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
            .map_err(|e| format!("创建技能文件 {} 失败：{e}", file.relative.display()))?;
        output
            .write_all(&bytes)
            .and_then(|_| output.flush())
            .map_err(|e| format!("复制技能文件 {} 失败：{e}", file.relative.display()))?;
        if let Some(permissions) = permissions {
            fs::set_permissions(&destination, permissions)
                .map_err(|e| format!("设置技能文件权限 {} 失败：{e}", file.relative.display()))?;
        }
    }
    Ok(())
}

fn validate_relative_path(path: &Path) -> Result<(), String> {
    let components: Vec<_> = path.components().collect();
    if components.is_empty() || components.len() > MAX_DEPTH {
        return Err("技能包路径为空或嵌套过深".into());
    }
    if components
        .iter()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(format!("技能包包含不安全路径：{}", path.display()));
    }
    Ok(())
}

fn validate_skill_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() || name.chars().count() > 80 {
        return Err("技能名称必须为 1–80 个字符".into());
    }
    if name.contains(['/', '\\']) || name.chars().any(char::is_control) {
        return Err("技能名称不能包含路径分隔符或控制字符".into());
    }
    Ok(())
}

fn runtime_skill_slug(name: &str) -> String {
    let mut output = String::new();
    for character in name.trim().chars() {
        let normalized = character.to_ascii_lowercase();
        let normalized = if normalized.is_ascii_lowercase() || normalized.is_ascii_digit() {
            normalized
        } else {
            '-'
        };
        if normalized == '-' && output.ends_with('-') {
            continue;
        }
        output.push(normalized);
    }
    let output = output.trim_matches('-');
    if !output.is_empty() {
        return output
            .chars()
            .take(64)
            .collect::<String>()
            .trim_matches('-')
            .to_string();
    }
    let digest = Sha256::digest(name.as_bytes());
    format!("local-skill-{}", &format!("{digest:x}")[..8])
}

fn ignored_dir(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(|n| n.to_str()),
        Some(".git" | "node_modules" | "target" | "__pycache__" | ".venv")
    )
}

fn managed_skills_root() -> PathBuf {
    crate::paths::echo_agent_home_dir().join("skills")
}

fn staging_root() -> PathBuf {
    crate::paths::echo_agent_home_dir().join(".skill-staging")
}

fn slugify(name: &str) -> String {
    runtime_skill_slug(name)
}

fn allocate_target(root: &Path, slug: &str) -> PathBuf {
    let first = root.join(slug);
    if !first.exists() {
        return first;
    }
    for index in 2..10_000 {
        let candidate = root.join(format!("{slug}-{index}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    root.join(format!("{slug}-{}", Uuid::now_v7()))
}

fn find_managed_by_name(name: &str) -> Option<PathBuf> {
    let root = managed_skills_root();
    find_managed_by_name_in(&root, name)
}

fn find_managed_by_name_in(root: &Path, name: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir()
            || path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with('.'))
        {
            continue;
        }
        if read_manifest(&path).is_some_and(|m| m.name.eq_ignore_ascii_case(name)) {
            return Some(path);
        }
    }
    None
}

fn read_manifest(path: &Path) -> Option<InstallManifest> {
    let bytes =
        crate::shell_fs::read_regular_file_bounded(&path.join(INSTALL_MANIFEST), 1024 * 1024)
            .ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn clear_disabled_skill(name: &str) -> Result<(), String> {
    crate::providers::update_config(|config| {
        let Some(root) = config.as_table_mut() else {
            return Ok(());
        };
        let Some(skills) = root.get_mut("skills").and_then(|v| v.as_table_mut()) else {
            return Ok(());
        };
        let Some(disabled) = skills.get_mut("disabled").and_then(|v| v.as_array_mut()) else {
            return Ok(());
        };
        disabled.retain(|value| value.as_str() != Some(name));
        if disabled.is_empty() {
            skills.remove("disabled");
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_skill(root: &Path, body: &str) {
        fs::create_dir_all(root).unwrap();
        fs::write(
            root.join("SKILL.md"),
            format!("---\nname: test-skill\ndescription: test\nversion: 1.2.3\n---\n{body}"),
        )
        .unwrap();
    }

    #[test]
    fn inspection_reads_metadata_and_hash() {
        let dir = tempfile::tempdir().unwrap();
        write_skill(dir.path(), "Use this carefully.");
        let prepared = prepare_package(dir.path()).unwrap();
        let report = inspect_prepared(&prepared).unwrap();
        assert_eq!(report.name, "test-skill");
        assert_eq!(report.version.as_deref(), Some("1.2.3"));
        assert_eq!(report.risk_level, SkillRiskLevel::Low);
        assert_eq!(report.source_hash.len(), 64);
    }

    #[test]
    fn directory_package_is_an_owned_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        write_skill(dir.path(), "original body");
        let prepared = prepare_package(dir.path()).unwrap();
        write_skill(dir.path(), "changed after selection");

        let snapshotted = fs::read_to_string(prepared.root.join("SKILL.md")).unwrap();
        assert!(snapshotted.contains("original body"));
        assert!(!snapshotted.contains("changed after selection"));
    }

    #[test]
    fn install_approval_is_bound_to_the_inspected_hash() {
        let hash = "a".repeat(64);
        assert!(require_matching_source_hash(&hash, &hash).is_ok());
        assert!(require_matching_source_hash(&hash, &"b".repeat(64))
            .unwrap_err()
            .contains("已发生变化"));
        assert!(require_matching_source_hash("not-a-hash", &hash)
            .unwrap_err()
            .contains("指纹"));
    }

    #[test]
    fn inspection_marks_destructive_script_high_risk() {
        let dir = tempfile::tempdir().unwrap();
        write_skill(dir.path(), "Run scripts/cleanup.sh");
        fs::create_dir_all(dir.path().join("scripts")).unwrap();
        fs::write(dir.path().join("scripts/cleanup.sh"), "rm -rf /tmp/example").unwrap();
        let prepared = prepare_package(dir.path()).unwrap();
        let report = inspect_prepared(&prepared).unwrap();
        assert_eq!(report.risk_level, SkillRiskLevel::High);
        assert!(report
            .findings
            .iter()
            .any(|f| f.code == "destructive-command"));
    }

    #[test]
    fn managed_install_update_and_uninstall_roundtrip() {
        let source = tempfile::tempdir().unwrap();
        let managed = tempfile::tempdir().unwrap();
        let root = managed.path().join("skills");
        write_skill(source.path(), "Use this carefully.");

        let prepared = prepare_package(source.path()).unwrap();
        let inspection = inspect_prepared(&prepared).unwrap();
        let source_hash = inspection.source_hash.clone();
        let installed = install_prepared(&prepared, inspection, &root).unwrap();
        let installed_path = PathBuf::from(&installed.installed_path);
        assert!(!installed.updated);
        assert!(installed_path.join("SKILL.md").is_file());
        assert!(installed_path.join(INSTALL_MANIFEST).is_file());

        // Reinstalling from the managed copy must ignore our private manifest,
        // retain the content fingerprint and atomically replace the same path.
        let update_source = prepare_package(&installed_path).unwrap();
        let update_inspection = inspect_prepared(&update_source).unwrap();
        assert_eq!(update_inspection.source_hash, source_hash);
        let updated = install_prepared(&update_source, update_inspection, &root).unwrap();
        assert!(updated.updated);
        assert_eq!(PathBuf::from(&updated.installed_path), installed_path);

        uninstall_path_in(&installed_path, &root, false).unwrap();
        assert!(!installed_path.exists());
    }

    #[test]
    fn package_rejects_multiple_skill_files() {
        let dir = tempfile::tempdir().unwrap();
        write_skill(&dir.path().join("one"), "one");
        write_skill(&dir.path().join("two"), "two");
        assert!(locate_skill_root(dir.path())
            .unwrap_err()
            .contains("一次只能安装一个"));
    }

    #[test]
    fn slug_is_path_safe_and_runtime_compatible() {
        assert_eq!(slugify("My Skill / 分析"), "my-skill");
        assert!(slugify("分析").starts_with("local-skill-"));
        assert!(slugify("../").starts_with("local-skill-"));
    }

    #[test]
    fn upload_package_has_one_root_skill_and_excludes_private_manifest() {
        let dir = tempfile::tempdir().unwrap();
        write_skill(dir.path(), "Use this carefully.");
        fs::write(dir.path().join(INSTALL_MANIFEST), "private").unwrap();
        fs::create_dir_all(dir.path().join("references")).unwrap();
        fs::write(dir.path().join("references/policy.md"), "policy").unwrap();

        let (name, bytes) =
            package_skill_for_upload(dir.path().join("SKILL.md").to_str().unwrap()).unwrap();
        assert_eq!(name, "test-skill.zip");
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        assert!(archive.by_name("SKILL.md").is_ok());
        assert!(archive.by_name("references/policy.md").is_ok());
        assert!(archive.by_name(INSTALL_MANIFEST).is_err());
    }
}
