//! Expert marketplace data — read LIVE from a local EchoAgent data directory
//! (default `${ECHO_AGENT_HOME}/experts-marketplace`, overridable from the UI).
//!
//! Layout we consume:
//!   <root>/_meta/_expert_center.json      — categories + experts (rich fields)
//!   <root>/<plugin>/.aily-plugin/plugin.json   (or `.echo-agent-plugin/`)
//!        — the *local* avatar path (`avatars/expert.png` / `avatars/team.png`)
//!
//! The manifest carries everything the cards need (author, `operationalTag` =
//! 特邀专家 ribbon, `isOPC`, `displayPosition`, tags, localized names, the flat
//! COS avatar URL). The plugin.json gives us the on-disk avatar so we can show
//! the real image offline via `experts_thumbnail` (no network / asset-protocol
//! dependency). Avatars total ~100 MB at full res, so we never inline them — the
//! frontend asks for a small cached JPEG per visible card instead.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

const MAX_LOADED_ROOTS: usize = 64;
const MAX_MANIFEST_BYTES: u64 = 8 * 1024 * 1024;
const MAX_PLUGIN_JSON_BYTES: u64 = 1024 * 1024;
const MAX_FEATURED_SCENES_BYTES: u64 = 2 * 1024 * 1024;
const MAX_PROMPT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_EXPERT_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_EXPERT_THUMB_BYTES: u64 = 2 * 1024 * 1024;
const MAX_EXPERT_IMAGE_DIMENSION: u32 = 20_000;
const MAX_EXPERT_IMAGE_ALLOC: u64 = 160 * 1024 * 1024;
const MAX_LINKED_AGENTS: usize = 64;
const MAX_LINKED_AGENT_TOTAL_BYTES: u64 = 16 * 1024 * 1024;
const MAX_TRUSTED_EXPERT_BINDINGS: usize = 4_096;
const TRUSTED_REMOTE_ASSET_HOSTS: &[&str] = &[];

static LOADED_ROOTS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
type TrustedExpertMap = HashMap<(String, String), Vec<TrustedExpertBinding>>;

static TRUSTED_EXPERTS: OnceLock<Mutex<TrustedExpertMap>> = OnceLock::new();

#[derive(Debug, Clone, PartialEq, Eq)]
struct TrustedExpertBinding {
    name: String,
    avatar_local: Option<String>,
}

fn loaded_roots() -> &'static Mutex<HashSet<PathBuf>> {
    LOADED_ROOTS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn trusted_experts() -> &'static Mutex<TrustedExpertMap> {
    TRUSTED_EXPERTS.get_or_init(|| Mutex::new(HashMap::new()))
}

// ---------- output types ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExpertCategory {
    pub id: String,
    pub zh: String,
    pub en: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpertItem {
    pub id: String,
    pub cat: String,
    pub name: String,
    pub name_en: String,
    pub title: String,
    pub title_en: String,
    pub desc: String,
    pub tags: Vec<String>,
    /// "agent" | "team".
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// operationalTag text (e.g. 特邀专家); None when absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ribbon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub init: Option<String>,
    #[serde(default)]
    pub opc: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pos: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated: Option<String>,
    /// Absolute local avatar path (feed to `experts_thumbnail`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_local: Option<String>,
    /// COS fallback URL (used if the local file is missing).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    /// Plugin directory name (e.g. "accessibility-auditor") — used to locate
    /// the agent prompt file at `<root>/<plugin>/agents/<agent_name>.md`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin: Option<String>,
    /// Agent markdown filename stem (e.g. "accessibility-auditor") — the lead
    /// agent for team experts, or the sole agent for single-agent experts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
    /// Quick prompts ("试试这样问我") from the manifest.
    #[serde(default)]
    pub quick_prompts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeaturedSceneOut {
    pub id: String,
    pub zh: String,
    pub expert_ids: Vec<String>,
    /// Absolute local banner path (feed to `experts_image_bytes`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_local: Option<String>,
    /// COS fallback URL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpertCatalog {
    pub root: String,
    pub categories: Vec<ExpertCategory>,
    pub experts: Vec<ExpertItem>,
    /// 精选场景 from `<root>/_meta/featuredScenes.json` (empty if absent — the
    /// frontend then uses its gradient fallback).
    pub featured_scenes: Vec<FeaturedSceneOut>,
}

// ---------- helpers ----------

/// First non-empty of `value.zh`, `value.en`, or the string itself.
fn loc(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Object(m) => m
            .get("zh")
            .and_then(|v| v.as_str())
            .or_else(|| m.get("en").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string(),
        _ => String::new(),
    }
}

fn loc_trimmed(value: &Value) -> Option<String> {
    let s = loc(value).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn read_bounded_file(path: &Path, max_bytes: u64, label: &str) -> Result<Vec<u8>, String> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|error| format!("读取{label}信息失败：{error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("{label}必须是普通文件，不能是符号链接"));
    }
    if metadata.len() > max_bytes {
        return Err(format!(
            "{label}超过 {} MB 安全上限",
            max_bytes / 1024 / 1024
        ));
    }
    crate::shell_fs::read_regular_file_bounded(path, max_bytes)
        .map_err(|error| format!("读取{label}失败：{error}"))
}

fn is_safe_component(value: &str) -> bool {
    let mut components = Path::new(value).components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}

fn resolve_regular_file_under(root: &Path, relative: &Path) -> Option<PathBuf> {
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return None;
    }
    let canonical_root = root.canonicalize().ok()?;
    let candidate = canonical_root.join(relative);
    let metadata = std::fs::symlink_metadata(&candidate).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return None;
    }
    let canonical = candidate.canonicalize().ok()?;
    canonical.starts_with(&canonical_root).then_some(canonical)
}

fn authorize_catalog_root(
    access: &crate::shell_fs::FilesystemAccess,
    raw: &str,
) -> Result<PathBuf, String> {
    let requested = PathBuf::from(raw);
    crate::paths::reject_legacy_workbuddy_path(&requested)?;
    let canonical = requested
        .canonicalize()
        .map_err(|error| format!("无法解析专家目录：{error}"))?;
    if !canonical.is_dir() {
        return Err("专家目录不存在".into());
    }
    let is_native_default = candidate_roots().into_iter().any(|candidate| {
        candidate
            .canonicalize()
            .is_ok_and(|candidate| candidate == canonical)
    });
    if is_native_default {
        Ok(canonical)
    } else {
        access.require_workspace(raw)
    }
}

fn remember_loaded_root(root: &Path) -> Result<(), String> {
    let mut roots = loaded_roots()
        .lock()
        .map_err(|_| "专家目录授权状态已损坏".to_string())?;
    if !roots.contains(root) && roots.len() >= MAX_LOADED_ROOTS {
        return Err(format!("本次运行最多加载 {MAX_LOADED_ROOTS} 个专家目录"));
    }
    roots.insert(root.to_path_buf());
    Ok(())
}

fn remember_loaded_experts(experts: &[ExpertItem]) -> Result<(), String> {
    let mut trusted = trusted_experts()
        .lock()
        .map_err(|_| "专家绑定授权状态已损坏".to_string())?;
    let mut total = trusted.values().map(Vec::len).sum::<usize>();
    for expert in experts {
        let display_name = if expert.title.trim().is_empty() {
            expert.name.trim()
        } else {
            expert.title.trim()
        };
        if expert.id.trim().is_empty() || display_name.is_empty() {
            continue;
        }
        let candidate = TrustedExpertBinding {
            name: display_name.to_string(),
            avatar_local: expert.avatar_local.clone(),
        };
        let entries = trusted
            .entry(("marketplace".to_string(), expert.id.clone()))
            .or_default();
        if entries.contains(&candidate) {
            continue;
        }
        if total >= MAX_TRUSTED_EXPERT_BINDINGS {
            return Err(format!(
                "本次运行最多加载 {MAX_TRUSTED_EXPERT_BINDINGS} 个专家绑定"
            ));
        }
        entries.push(candidate);
        total += 1;
    }
    Ok(())
}

/// Resolve renderer-provided expert metadata back to an exact row emitted by
/// a backend-loaded catalog. In particular, an arbitrary local avatar path can
/// never become a persisted UI read capability.
pub(crate) fn require_loaded_marketplace_expert(
    expert_id: &str,
    expert_name: &str,
    avatar_local: Option<&str>,
) -> Result<crate::meta::ExpertBinding, String> {
    let trusted = trusted_experts()
        .lock()
        .map_err(|_| "专家绑定授权状态已损坏".to_string())?;
    let entries = trusted
        .get(&("marketplace".to_string(), expert_id.to_string()))
        .ok_or_else(|| "专家尚未由后端目录加载".to_string())?;
    let entry = entries
        .iter()
        .find(|entry| entry.name == expert_name && entry.avatar_local.as_deref() == avatar_local)
        .ok_or_else(|| "专家名称或头像与后端目录不一致".to_string())?;
    Ok(crate::meta::ExpertBinding {
        expert_id: expert_id.to_string(),
        expert_name: entry.name.clone(),
        source: "marketplace".into(),
        avatar_local: entry.avatar_local.clone(),
    })
}

fn require_loaded_root(raw: &str) -> Result<PathBuf, String> {
    let requested = PathBuf::from(raw);
    crate::paths::reject_legacy_workbuddy_path(&requested)?;
    let canonical = requested
        .canonicalize()
        .map_err(|error| format!("无法解析专家目录：{error}"))?;
    let roots = loaded_roots()
        .lock()
        .map_err(|_| "专家目录授权状态已损坏".to_string())?;
    roots
        .contains(&canonical)
        .then_some(canonical)
        .ok_or_else(|| "专家目录尚未由后端加载".to_string())
}

fn require_loaded_file(raw: &str) -> Result<PathBuf, String> {
    let requested = PathBuf::from(raw);
    crate::paths::reject_legacy_workbuddy_path(&requested)?;
    let metadata = std::fs::symlink_metadata(&requested)
        .map_err(|error| format!("无法读取专家资源：{error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("专家资源必须是普通文件，不能是符号链接".into());
    }
    let canonical = requested
        .canonicalize()
        .map_err(|error| format!("无法解析专家资源：{error}"))?;
    let roots = loaded_roots()
        .lock()
        .map_err(|_| "专家目录授权状态已损坏".to_string())?;
    roots
        .iter()
        .any(|root| canonical.starts_with(root))
        .then_some(canonical)
        .ok_or_else(|| "拒绝读取已加载专家目录之外的资源".to_string())
}

fn read_plugin_json(root: &Path, plugin: &str) -> Option<Value> {
    if !is_safe_component(plugin) {
        return None;
    }
    for sub in [".aily-plugin", ".echo-agent-plugin"] {
        let relative = Path::new(plugin).join(sub).join("plugin.json");
        if let Some(p) = resolve_regular_file_under(root, &relative) {
            let bytes = read_bounded_file(&p, MAX_PLUGIN_JSON_BYTES, "plugin.json").ok()?;
            if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
                return Some(v);
            }
        }
    }
    None
}

fn resolve_remote_asset(asset: &str) -> Option<String> {
    let t = asset.trim();
    if t.is_empty() {
        return None;
    }
    let url = url::Url::parse(t).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let host = url.host_str()?.trim_end_matches('.').to_ascii_lowercase();
    if !TRUSTED_REMOTE_ASSET_HOSTS.contains(&host.as_str()) || !is_public_remote_asset_host(&host) {
        return None;
    }
    Some(url.to_string())
}

fn is_public_remote_asset_host(host: &str) -> bool {
    if host.is_empty()
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".localdomain")
        || host.ends_with(".internal")
        || host.ends_with(".lan")
        || host == "home.arpa"
        || host.ends_with(".home.arpa")
    {
        return false;
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return match ip {
            std::net::IpAddr::V4(ip) => {
                !(ip.is_private()
                    || ip.is_loopback()
                    || ip.is_link_local()
                    || ip.is_multicast()
                    || ip.is_broadcast()
                    || ip.is_documentation()
                    || ip.is_unspecified()
                    || ip.octets()[0] == 0
                    || ip.octets()[0] >= 224
                    || (ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1])))
            }
            std::net::IpAddr::V6(ip) => {
                !(ip.is_loopback()
                    || ip.is_multicast()
                    || ip.is_unspecified()
                    || ip.segments()[0] & 0xfe00 == 0xfc00
                    || ip.segments()[0] & 0xffc0 == 0xfe80)
            }
        };
    }
    // Domain names are only accepted after an explicit asset-host allow-list
    // match. This helper keeps future additions from allowing obvious local
    // aliases or literal private IPs by accident.
    true
}

// ---------- root discovery ----------

/// Candidate roots probed when the user hasn't picked one. The first whose
/// `_meta/_expert_center.json` exists wins. The canonical marketplace is a
/// child of `ECHO_AGENT_HOME`; historical locations remain read-only fallbacks
/// so upgrades do not strand an existing catalog.
fn candidate_roots() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(path) =
        crate::paths::first_env_path(&["ECHO_AGENT_EXPERTS_DIR", "ECHOAGENT_AGENTS_DIR"])
    {
        crate::paths::push_unique_path(&mut out, path);
    }
    crate::paths::push_unique_path(&mut out, crate::paths::experts_marketplace_dir());

    if let Some(h) = dirs::home_dir() {
        crate::paths::push_unique_path(&mut out, h.join("EchoAgent").join("agents"));
        crate::paths::push_unique_path(&mut out, h.join("agents"));
    }
    out
}

fn root_has_manifest(root: &Path) -> bool {
    resolve_regular_file_under(root, Path::new("_meta/_expert_center.json")).is_some()
}

/// Return the default data root (first existing candidate), or "" if none.
#[tauri::command]
pub async fn experts_default_root() -> Result<String, String> {
    for r in candidate_roots() {
        if crate::paths::reject_legacy_workbuddy_path(&r).is_ok() && root_has_manifest(&r) {
            return Ok(r.canonicalize().unwrap_or(r).to_string_lossy().into_owned());
        }
    }
    Ok(String::new())
}

/// Directories under `root` that look like an expert data root (have the
/// manifest). Used by the UI's "选择来源目录" picker to validate a selection.
#[tauri::command]
pub async fn experts_list_roots(
    access: State<'_, crate::shell_fs::FilesystemAccess>,
    root: String,
) -> Result<Vec<String>, String> {
    let base = authorize_catalog_root(&access, &root)?;
    let mut hits = Vec::new();
    if root_has_manifest(&base) {
        hits.push(base.to_string_lossy().into_owned());
    }
    if let Ok(rd) = std::fs::read_dir(&base) {
        for entry in rd.flatten() {
            let p = entry.path();
            let metadata = match std::fs::symlink_metadata(&p) {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            if metadata.file_type().is_symlink() || !metadata.is_dir() || !root_has_manifest(&p) {
                continue;
            }
            if let Ok(canonical) = p.canonicalize() {
                if canonical.starts_with(&base) {
                    hits.push(canonical.to_string_lossy().into_owned());
                }
            }
        }
    }
    Ok(hits)
}

// ---------- load ----------

/// Parse the manifest at `<root>/_meta/_expert_center.json` and merge each
/// expert with its local plugin.json (for the on-disk avatar path).
#[tauri::command]
pub async fn experts_load(
    access: State<'_, crate::shell_fs::FilesystemAccess>,
    root: Option<String>,
) -> Result<ExpertCatalog, String> {
    let root = match root {
        Some(r) if !r.is_empty() => authorize_catalog_root(&access, &r)?,
        _ => {
            let mut found = PathBuf::new();
            for r in candidate_roots() {
                if crate::paths::reject_legacy_workbuddy_path(&r).is_ok() && root_has_manifest(&r) {
                    found = r;
                    break;
                }
            }
            if found.as_os_str().is_empty() {
                return Err("未找到专家数据目录（_meta/_expert_center.json）".into());
            }
            found
                .canonicalize()
                .map_err(|error| format!("无法解析专家目录：{error}"))?
        }
    };
    crate::paths::reject_legacy_workbuddy_path(&root)?;
    let manifest_path = resolve_regular_file_under(&root, Path::new("_meta/_expert_center.json"))
        .ok_or("专家 manifest 不存在或不安全")?;
    let bytes = read_bounded_file(&manifest_path, MAX_MANIFEST_BYTES, "专家 manifest")?;
    let manifest: Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("解析 manifest 失败：{e}"))?;

    let categories = manifest
        .get("categories")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|c| {
                    let id = c.get("id")?.as_str()?.to_string();
                    let name = c.get("name").cloned().unwrap_or(Value::Null);
                    Some(ExpertCategory {
                        id,
                        zh: loc(&name),
                        en: c
                            .get("name")
                            .and_then(|n| n.get("en"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let experts = manifest
        .get("experts")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| build_expert(&root, e))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let featured_scenes = load_featured_scenes(&root);
    remember_loaded_root(&root)?;
    remember_loaded_experts(&experts)?;

    Ok(ExpertCatalog {
        root: root.to_string_lossy().into_owned(),
        categories,
        experts,
        featured_scenes,
    })
}

/// Parse `<root>/_meta/featuredScenes.json` and resolve each banner to a local
/// file when present (we ship them under `_meta/scene-images/`). Missing file or
/// parse error yields an empty list — the frontend falls back to gradients.
fn load_featured_scenes(root: &Path) -> Vec<FeaturedSceneOut> {
    let Some(path) = resolve_regular_file_under(root, Path::new("_meta/featuredScenes.json"))
    else {
        return Vec::new();
    };
    let bytes = match read_bounded_file(&path, MAX_FEATURED_SCENES_BYTES, "精选场景配置") {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    let v: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let arr = match v.get("scenes").and_then(|s| s.as_array()) {
        Some(a) => a,
        None => return Vec::new(),
    };
    arr.iter()
        .filter_map(|s| {
            let id = s.get("id")?.as_str()?.to_string();
            let zh = loc(&s.get("displayName").cloned().unwrap_or(Value::Null));
            let expert_ids = s
                .get("expertIds")
                .and_then(|a| a.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            let image = s.get("image").and_then(|x| x.as_str()).unwrap_or("").trim();
            let image_local = if image.is_empty() {
                None
            } else {
                let rel = image.trim_start_matches('/');
                let cands = [Path::new("_meta").join(rel), PathBuf::from(rel)];
                cands
                    .into_iter()
                    .find_map(|path| resolve_regular_file_under(root, &path))
                    .map(|p| p.to_string_lossy().into_owned())
            };
            let image_url = if image.is_empty() {
                None
            } else {
                resolve_remote_asset(image)
            };
            Some(FeaturedSceneOut {
                id,
                zh,
                expert_ids,
                image_local,
                image_url,
            })
        })
        .collect()
}

fn build_expert(root: &Path, e: &Value) -> Option<ExpertItem> {
    let id = e.get("id")?.as_str()?.to_string();
    let plugin = e.get("plugin").and_then(|v| v.as_str()).unwrap_or("");
    let pj = read_plugin_json(root, plugin);
    let local_avatar = pj.as_ref().and_then(|pj| {
        if !is_safe_component(plugin) {
            return None;
        }
        let rel = pj.get("avatar")?.as_str()?;
        let relative = Path::new(plugin).join(rel);
        resolve_regular_file_under(root, &relative).map(|path| path.to_string_lossy().into_owned())
    });
    // Resolve the lead agent name from plugin.json (agentName field).
    let agent_name = pj
        .as_ref()
        .and_then(|pj| pj.get("agentName").and_then(|v| v.as_str()))
        .map(|s| s.to_string());
    let avatar_url = e
        .get("avatar")
        .and_then(|v| v.as_str())
        .and_then(resolve_remote_asset);
    let kind = if e.get("expertType").and_then(|v| v.as_str()) == Some("team") {
        "team".to_string()
    } else {
        "agent".to_string()
    };
    let tags = e
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .map(loc)
                .filter(|s| !s.is_empty())
                .take(3)
                .collect()
        })
        .unwrap_or_default();
    let desc = {
        let dd = e.get("displayDescription").cloned().unwrap_or(Value::Null);
        let d = loc(&dd);
        if d.is_empty() {
            loc(&e.get("description").cloned().unwrap_or(Value::Null))
        } else {
            d
        }
    };
    Some(ExpertItem {
        id,
        cat: e
            .get("categoryId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        name: loc(&e.get("displayName").cloned().unwrap_or(Value::Null)),
        name_en: e
            .get("displayName")
            .and_then(|n| n.get("en"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        title: loc(&e.get("profession").cloned().unwrap_or(Value::Null)),
        title_en: e
            .get("profession")
            .and_then(|n| n.get("en"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        desc,
        tags,
        kind,
        author: loc_trimmed(&e.get("author").cloned().unwrap_or(Value::Null)),
        ribbon: loc_trimmed(&e.get("operationalTag").cloned().unwrap_or(Value::Null)),
        init: loc_trimmed(&e.get("defaultInitPrompt").cloned().unwrap_or(Value::Null)),
        opc: e.get("isOPC").and_then(|v| v.as_bool()).unwrap_or(false),
        pos: e.get("displayPosition").and_then(|v| v.as_i64()),
        updated: e
            .get("updatedAt")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        avatar_local: local_avatar,
        avatar_url,
        plugin: if plugin.is_empty() {
            None
        } else {
            Some(plugin.to_string())
        },
        agent_name,
        quick_prompts: e
            .get("quickPrompts")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .map(loc)
                    .filter(|s| !s.is_empty())
                    .take(5)
                    .collect()
            })
            .unwrap_or_default(),
    })
}

// ---------- thumbnails ----------

/// Long edge (px) of generated thumbnails — cards render at ≤44px, scenes ≤24px,
/// so 96px covers retina without bloating the cache.
const THUMB_SIZE: u32 = 96;
const THUMB_QUALITY: u8 = 82;

fn thumb_cache_dir() -> PathBuf {
    crate::paths::echo_agent_home_dir().join("expert-thumbs")
}

/// A stable cache filename derived from the source path + mtime (so editing the
/// source regenerates the thumb).
fn thumb_path_for(src: &Path) -> PathBuf {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    src.to_string_lossy().as_ref().hash(&mut h);
    let mtime = std::fs::metadata(src)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    mtime.hash(&mut h);
    let name = format!("{:016x}.jpg", h.finish());
    thumb_cache_dir().join(name)
}

async fn make_thumbnail(src: &Path) -> Result<String, String> {
    let source_metadata =
        std::fs::symlink_metadata(src).map_err(|error| format!("读取头像信息失败：{error}"))?;
    if source_metadata.file_type().is_symlink() || !source_metadata.is_file() {
        return Err("头像必须是普通文件".into());
    }
    if source_metadata.len() > MAX_EXPERT_IMAGE_BYTES {
        return Err("头像超过 20 MB 安全上限".into());
    }
    let cache = thumb_path_for(src);
    if std::fs::symlink_metadata(&cache).is_ok_and(|metadata| {
        !metadata.file_type().is_symlink()
            && metadata.is_file()
            && metadata.len() > 0
            && metadata.len() <= MAX_EXPERT_THUMB_BYTES
    }) {
        let bytes = read_bounded_file(&cache, MAX_EXPERT_THUMB_BYTES, "头像缓存")?;
        return Ok(b64(&bytes));
    }
    // Decode + resize off the async runtime (image work is CPU-bound).
    let source_bytes = read_bounded_file(src, MAX_EXPERT_IMAGE_BYTES, "头像")?;
    let jpeg = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        use image::imageops::FilterType;
        let mut reader = image::ImageReader::new(std::io::Cursor::new(source_bytes))
            .with_guessed_format()
            .map_err(|e| format!("识别图片格式失败：{e}"))?;
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(MAX_EXPERT_IMAGE_DIMENSION);
        limits.max_image_height = Some(MAX_EXPERT_IMAGE_DIMENSION);
        limits.max_alloc = Some(MAX_EXPERT_IMAGE_ALLOC);
        reader.limits(limits);
        let img = reader.decode().map_err(|e| format!("解码图片失败：{e}"))?;
        let thumb = img.resize(THUMB_SIZE, THUMB_SIZE, FilterType::Triangle);
        let rgb = thumb.into_rgb8();
        let (w, h) = (rgb.width(), rgb.height());
        let mut buf = Vec::with_capacity(8 * 1024);
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, THUMB_QUALITY);
        enc.encode(rgb.as_raw(), w, h, image::ColorType::Rgb8.into())
            .map_err(|e| format!("编码 JPEG 失败：{e}"))?;
        Ok(buf)
    })
    .await
    .map_err(|e| format!("缩略图任务失败：{e}"))??;

    // Cache write is best-effort; a failure still returns the image.
    let _ = crate::paths::write_private_file(&cache, &jpeg);
    Ok(b64(&jpeg))
}

fn b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Return a small base64-encoded JPEG thumbnail for a local avatar path. The
/// frontend wraps this in a `data:` URL and caches it; only visible cards call
/// this, so the ~100 MB of full-res avatars is never loaded wholesale.
#[tauri::command]
pub async fn experts_thumbnail(path: String) -> Result<String, String> {
    let src = require_loaded_file(&path)?;
    make_thumbnail(&src).await
}

/// Read a local image file (e.g. a 精选场景 banner) and return its bytes as
/// base64, so the frontend can show it via a `data:` URL without depending on
/// the asset protocol. Banners are ~100 KB each and few, so no resizing.
#[tauri::command]
pub async fn experts_image_bytes(path: String) -> Result<String, String> {
    let src = require_loaded_file(&path)?;
    let bytes = read_bounded_file(&src, MAX_FEATURED_SCENES_BYTES, "场景图片")?;
    let mime = match src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => "application/octet-stream",
    };
    Ok(format!("data:{mime};base64,{}", b64(&bytes)))
}

// ---------- agent prompt reading ----------

/// Read the full agent prompt markdown from an expert's package directory.
///
/// Resolves `<root>/<plugin>/agents/<agent_name>.md`. If the exact file is
/// missing, falls back to scanning `agents/` for a single `.md` file (common
/// for single-agent experts where the filename might differ slightly).
///
/// Returns the full file content (frontmatter + body). The frontend strips the
/// frontmatter before injecting into the conversation.
#[tauri::command]
pub async fn experts_read_agent_prompt(
    root: String,
    plugin: String,
    agent_name: String,
) -> Result<String, String> {
    let root = require_loaded_root(&root)?;
    if !is_safe_component(&plugin) || !is_safe_component(&agent_name) {
        return Err("专家插件或 Agent 名称不合法".into());
    }
    let agents_relative = Path::new(&plugin).join("agents");
    let agents_dir = root.join(&agents_relative);
    let canonical_agents = agents_dir
        .canonicalize()
        .map_err(|error| format!("无法解析 agents 目录：{error}"))?;
    if !canonical_agents.is_dir() || !canonical_agents.starts_with(&root) {
        return Err("拒绝读取专家目录之外的 Agent prompt".into());
    }

    // Primary: exact match.
    let primary_relative = agents_relative.join(format!("{agent_name}.md"));
    if let Some(primary) = resolve_regular_file_under(&root, &primary_relative) {
        let bytes = read_bounded_file(&primary, MAX_PROMPT_BYTES, "Agent prompt")?;
        return String::from_utf8(bytes)
            .map_err(|error| format!("Agent prompt 不是 UTF-8：{error}"));
    }

    // Fallback: try case-insensitive match on the filename stem.
    if let Ok(entries) = std::fs::read_dir(&canonical_agents) {
        let target_lower = agent_name.to_lowercase();
        for entry in entries.flatten() {
            let path = entry.path();
            let metadata = match std::fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            if !metadata.file_type().is_symlink()
                && metadata.is_file()
                && path.extension().and_then(|e| e.to_str()) == Some("md")
            {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    if stem.to_lowercase() == target_lower {
                        let canonical = path
                            .canonicalize()
                            .map_err(|error| format!("无法解析 Agent prompt：{error}"))?;
                        if !canonical.starts_with(&canonical_agents) {
                            return Err("拒绝读取专家目录之外的 Agent prompt".into());
                        }
                        let bytes =
                            read_bounded_file(&canonical, MAX_PROMPT_BYTES, "Agent prompt")?;
                        return String::from_utf8(bytes)
                            .map_err(|error| format!("Agent prompt 不是 UTF-8：{error}"));
                    }
                }
            }
        }
    }

    Err(format!(
        "未找到 agent prompt 文件：{}/agents/{agent_name}.md",
        plugin
    ))
}

// ---------- team agent linking ----------

/// Copy a team expert's `agents/*.md` files into `~/.echo-agent/agents/` so that
/// EchoAgent's sub-agent discovery can find them by bare name when the lead agent
/// calls the Task tool. Returns the number of files linked.
///
/// This is needed because EchoAgent only scans `~/.echo-agent/agents/` and
/// `<cwd>/.echo-agent/agents/` — it doesn't know about the EchoAgent expert root.
/// By copying the member definitions, the lead agent's orchestration
/// instructions (e.g. "spawn macro-strategist") resolve correctly.
#[tauri::command]
pub async fn experts_link_agents(root: String, plugin: String) -> Result<u32, String> {
    let root = require_loaded_root(&root)?;
    if !is_safe_component(&plugin) {
        return Err("专家插件名称不合法".into());
    }
    let agents_dir = root.join(&plugin).join("agents");
    let agents_dir = agents_dir
        .canonicalize()
        .map_err(|error| format!("无法解析 agents 目录：{error}"))?;
    if !agents_dir.is_dir() || !agents_dir.starts_with(&root) {
        return Err(format!("agents 目录不存在：{}/agents", plugin));
    }

    // Target: ~/.echo-agent/agents/
    let target_dir = crate::agents_store::user_agents_dir_pub();
    if std::fs::symlink_metadata(&target_dir)
        .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err("拒绝将 Agent 写入符号链接目录".into());
    }
    std::fs::create_dir_all(&target_dir).map_err(|e| format!("创建 agents 目录失败：{e}"))?;
    let target_dir = target_dir
        .canonicalize()
        .map_err(|error| format!("无法解析 agents 目标目录：{error}"))?;
    let private_home = crate::paths::echo_agent_home_dir()
        .canonicalize()
        .map_err(|error| format!("无法解析 EchoAgent 数据目录：{error}"))?;
    if target_dir.parent() != Some(private_home.as_path()) {
        return Err("拒绝将 Agent 写入 EchoAgent 管理目录之外".into());
    }

    let mut count = 0u32;
    let mut discovered = 0_usize;
    let mut total_bytes = 0_u64;
    let entries =
        std::fs::read_dir(&agents_dir).map_err(|e| format!("读取 agents 目录失败：{e}"))?;
    for entry in entries.flatten() {
        let src = entry.path();
        let metadata = std::fs::symlink_metadata(&src)
            .map_err(|error| format!("读取团队 Agent 失败：{error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            continue;
        }
        let ext = src.extension().and_then(|e| e.to_str());
        if ext != Some("md") {
            continue;
        }
        discovered += 1;
        if discovered > MAX_LINKED_AGENTS {
            return Err(format!("专家团成员不能超过 {MAX_LINKED_AGENTS} 个"));
        }
        if metadata.len() > MAX_PROMPT_BYTES {
            return Err(format!("单个 Agent 定义超过 2 MB：{}", src.display()));
        }
        total_bytes = total_bytes
            .checked_add(metadata.len())
            .ok_or_else(|| "Agent 定义总大小溢出".to_string())?;
        if total_bytes > MAX_LINKED_AGENT_TOTAL_BYTES {
            return Err("Agent 定义总大小超过 16 MB".into());
        }
        let canonical_src = src
            .canonicalize()
            .map_err(|error| format!("无法解析团队 Agent：{error}"))?;
        if !canonical_src.starts_with(&agents_dir) {
            return Err("拒绝链接专家目录之外的 Agent".into());
        }
        let filename = src.file_name().unwrap().to_owned();
        let dst = target_dir.join(&filename);
        // Only copy if missing or source is newer (avoid redundant writes).
        let destination_is_symlink =
            std::fs::symlink_metadata(&dst).is_ok_and(|metadata| metadata.file_type().is_symlink());
        let should_copy = if destination_is_symlink {
            true
        } else if dst.is_file() {
            let src_mtime = std::fs::metadata(&src).and_then(|m| m.modified()).ok();
            let dst_mtime = std::fs::metadata(&dst).and_then(|m| m.modified()).ok();
            match (src_mtime, dst_mtime) {
                (Some(s), Some(d)) => s > d,
                _ => true,
            }
        } else {
            true
        };
        if should_copy {
            let bytes = read_bounded_file(&canonical_src, MAX_PROMPT_BYTES, "Agent 定义")?;
            crate::paths::write_private_file(&dst, &bytes)
                .map_err(|e| format!("复制 {} 失败：{e}", filename.to_string_lossy()))?;
            count += 1;
        }
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog_expert(id: &str, name: &str, avatar: Option<&str>) -> ExpertItem {
        ExpertItem {
            id: id.into(),
            cat: String::new(),
            name: name.into(),
            name_en: String::new(),
            title: name.into(),
            title_en: String::new(),
            desc: String::new(),
            tags: Vec::new(),
            kind: "agent".into(),
            author: None,
            ribbon: None,
            init: None,
            opc: false,
            pos: None,
            updated: None,
            avatar_local: avatar.map(str::to_string),
            avatar_url: None,
            plugin: None,
            agent_name: None,
            quick_prompts: Vec::new(),
        }
    }

    #[test]
    fn expert_binding_requires_exact_backend_catalog_metadata() {
        let id = "security-test-marketplace-expert";
        remember_loaded_experts(&[catalog_expert(
            id,
            "Trusted Expert",
            Some("/trusted/avatar.png"),
        )])
        .unwrap();
        let valid =
            require_loaded_marketplace_expert(id, "Trusted Expert", Some("/trusted/avatar.png"))
                .unwrap();
        assert_eq!(valid.avatar_local.as_deref(), Some("/trusted/avatar.png"));
        assert!(
            require_loaded_marketplace_expert(id, "Trusted Expert", Some("/etc/passwd")).is_err()
        );
        assert!(
            require_loaded_marketplace_expert(id, "Forged", Some("/trusted/avatar.png")).is_err()
        );
    }

    #[test]
    fn remote_assets_are_disabled_without_trusted_host_allowlist() {
        assert!(resolve_remote_asset("https://cdn.example.com/avatar.png").is_none());
        assert!(resolve_remote_asset("http://cdn.example.com/avatar.png").is_none());
        assert!(resolve_remote_asset("data:image/png;base64,AAAA").is_none());
        assert!(resolve_remote_asset("https://127.0.0.1/avatar.png").is_none());
        assert!(resolve_remote_asset("https://printer.local/avatar.png").is_none());
        assert!(resolve_remote_asset("/local/avatar.png").is_none());
    }
}
