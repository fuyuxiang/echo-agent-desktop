//! Connector marketplace — read LIVE from a local EchoAgent connector
//! marketplace directory (default
//! `${ECHO_AGENT_HOME}/connectors-marketplace`, overridable via the UI).
//!
//! Layout we consume:
//!   <root>/.echo-agent-connector/connectors.json   — marketplace manifest
//!        (top-level `connectors[]` array; each entry has id/name/description/
//!         source/type/auth_mode/examples_zh/examples_en)
//!   <root>/icons/<source>.svg | .png              — connector icons
//!   <root>/connectors/<source>/mcp.json           — MCP server config (optional,
//!         shown in the detail modal)
//!
//! This mirrors `experts.rs`: the manifest is the source of truth, icons are
//! resolved to absolute local paths so the frontend can lazy-load them as
//! data URLs via `connectors_icon` (no asset-protocol dependency).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;
const MAX_CONNECTOR_CONFIG_BYTES: u64 = 1024 * 1024;
const MAX_TOKEN_SCHEMA_BYTES: u64 = 512 * 1024;
const MAX_ICON_BYTES: u64 = 2 * 1024 * 1024;
const MAX_LOADED_MARKETPLACE_ROOTS: usize = 64;

fn loaded_marketplace_roots() -> &'static Mutex<HashSet<PathBuf>> {
    static ROOTS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    ROOTS.get_or_init(|| Mutex::new(HashSet::new()))
}

// ---------- output types ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectorCategory {
    pub id: String,
    pub zh: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorItem {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_en: Option<String>,
    pub desc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desc_en: Option<String>,
    /// Directory key used to locate `icons/<source>.*` and
    /// `connectors/<source>/mcp.json`.
    pub source: String,
    /// "mcp" | "cli" | "skill-only" | "unknown" (derived from `type`).
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_mode: Option<String>,
    /// Example prompts (`examples_zh`).
    #[serde(default)]
    pub examples_zh: Vec<String>,
    /// Derived category id (see `derive_category`).
    pub cat: String,
    /// Absolute local icon path (feed to `connectors_icon`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_local: Option<String>,
    /// Token-authorization form schema (from `token-schema.json`), present
    /// only for `auth_mode: "token"` connectors. The frontend renders this
    /// as an input form when the user clicks "连接".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_schema: Option<TokenSchema>,
}

/// One field in a token-schema form (`token-schema.json` → `fields[]`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenField {
    /// Env-var name the value is injected as (e.g. `WENDAO_API_KEY`).
    pub key: String,
    #[serde(default)]
    pub label: Option<String>,
    /// "password" → masked input; otherwise plain text.
    #[serde(default)]
    pub r#type: Option<String>,
    #[serde(default)]
    pub required: Option<bool>,
    #[serde(default)]
    pub placeholder: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

/// The `token-schema.json` payload (mirrors echo-agent's `readTokenSchema`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenSchema {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub doc_url: Option<String>,
    #[serde(default)]
    pub doc_label: Option<String>,
    pub fields: Vec<TokenField>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorCatalog {
    pub root: String,
    pub categories: Vec<ConnectorCategory>,
    pub connectors: Vec<ConnectorItem>,
}

// ---------- helpers ----------

/// First non-empty of `value` (string) , `value.zh`, or `value.en`.
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

fn loc_str(value: &Value, key: &str) -> Option<String> {
    let s = value
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Resolve the on-disk icon for a connector source. Tries `.svg` then `.png`
/// under `<root>/icons/`.
fn find_icon(root: &Path, source: &str) -> Option<String> {
    let icons = root.join("icons").canonicalize().ok()?;
    if icons.parent() != Some(root) {
        return None;
    }
    for ext in ["svg", "png"] {
        let p = icons.join(format!("{source}.{ext}"));
        let Ok(metadata) = std::fs::symlink_metadata(&p) else {
            continue;
        };
        if metadata.is_file() && !metadata.file_type().is_symlink() {
            let Ok(canonical) = p.canonicalize() else {
                continue;
            };
            if canonical.parent() == Some(icons.as_path()) {
                return Some(canonical.to_string_lossy().into_owned());
            }
        }
    }
    None
}

/// Read `<root>/connectors/<source>/token-schema.json` (present only for
/// `auth_mode: "token"` connectors). Returns None on missing file, parse
/// error, or a schema with no fields (mirrors echo-agent's `readTokenSchema`).
fn read_token_schema(root: &Path, source: &str) -> Option<TokenSchema> {
    let directory = canonical_connector_dir(&root.to_string_lossy(), source).ok()?;
    let p = directory.join("token-schema.json");
    let bytes = read_small_file(&p, MAX_TOKEN_SCHEMA_BYTES, "token-schema.json").ok()?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    let fields = v.get("fields").and_then(|f| f.as_array())?;
    if fields.is_empty() {
        return None;
    }
    let parsed: Vec<TokenField> = fields
        .iter()
        .map(|f| TokenField {
            key: f
                .get("key")
                .and_then(|k| k.as_str())
                .unwrap_or("")
                .to_string(),
            label: loc_str(f, "label"),
            r#type: loc_str(f, "type"),
            required: f.get("required").and_then(|r| r.as_bool()),
            placeholder: loc_str(f, "placeholder"),
            description: loc_str(f, "description"),
        })
        .filter(|tf| !tf.key.is_empty())
        .collect();
    if parsed.is_empty() {
        return None;
    }
    Some(TokenSchema {
        title: loc_str(&v, "title"),
        description: loc_str(&v, "description"),
        doc_url: loc_str(&v, "docUrl"),
        doc_label: loc_str(&v, "docLabel"),
        fields: parsed,
    })
}

/// Derive a category id from the connector entry. The marketplace manifest has
/// no `categories` field, so we synthesize one from `type` + `auth_mode`:
///   - needs auth (token / server-side / oneid-token) → "auth"
///   - type "mcp"                    → "mcp"
///   - type "cli"                    → "cli"
///   - type "skill-only"             → "skill"
///   - otherwise                     → "other"
fn derive_category(entry: &Value) -> String {
    let auth = entry
        .get("auth_mode")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if matches!(
        auth,
        "token" | "server-side" | "oneid-token" | "oneid_token" | "gateway"
    ) {
        return "auth".to_string();
    }
    match entry.get("type").and_then(|v| v.as_str()).unwrap_or("") {
        "mcp" => "mcp".to_string(),
        "cli" => "cli".to_string(),
        "skill-only" | "skill_only" => "skill".to_string(),
        _ => "other".to_string(),
    }
}

/// The fixed category catalogue (order matters for the chip row).
fn categories() -> Vec<ConnectorCategory> {
    vec![
        ConnectorCategory {
            id: "mcp".into(),
            zh: "MCP 服务".into(),
        },
        ConnectorCategory {
            id: "cli".into(),
            zh: "命令行".into(),
        },
        ConnectorCategory {
            id: "skill".into(),
            zh: "技能型".into(),
        },
        ConnectorCategory {
            id: "auth".into(),
            zh: "需授权".into(),
        },
        ConnectorCategory {
            id: "other".into(),
            zh: "其他".into(),
        },
    ]
}

// ---------- root discovery ----------

/// Candidate roots probed when the user hasn't picked one. The first whose
/// `.echo-agent-connector/connectors.json` exists wins. The standard root is
/// derived from `ECHO_AGENT_HOME`; the old fixed-home location is retained as
/// a compatibility fallback when a custom data home is introduced.
fn candidate_roots() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(path) =
        crate::paths::first_env_path(&["ECHO_AGENT_CONNECTORS_DIR", "ECHOAGENT_CONNECTORS_DIR"])
    {
        crate::paths::push_unique_path(&mut out, path);
    }
    crate::paths::push_unique_path(&mut out, crate::paths::connectors_marketplace_dir());

    if let Some(h) = dirs::home_dir() {
        crate::paths::push_unique_path(
            &mut out,
            h.join(".echo-agent").join("connectors-marketplace"),
        );
    }
    out
}

fn root_has_manifest(root: &Path) -> bool {
    let manifest = root.join(".echo-agent-connector").join("connectors.json");
    std::fs::symlink_metadata(manifest)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
}

pub(crate) fn validate_connector_source(source: &str) -> Result<&str, String> {
    let source = source.trim();
    if source.is_empty()
        || source.len() > 128
        || source == "."
        || source == ".."
        || source.contains('/')
        || source.contains('\\')
        || source.chars().any(char::is_control)
    {
        return Err("连接器 source 必须是单一安全路径分量".into());
    }
    Ok(source)
}

/// Resolve an explicitly selected marketplace root and prove that it is a
/// real directory containing the expected manifest. The canonical path is
/// returned so all later containment checks share the same namespace.
pub(crate) fn canonical_marketplace_root(root: &str) -> Result<PathBuf, String> {
    let requested = PathBuf::from(root);
    crate::paths::reject_legacy_workbuddy_path(&requested)?;
    let canonical = requested
        .canonicalize()
        .map_err(|error| format!("无法解析连接器目录：{error}"))?;
    if !canonical.is_dir() || !root_has_manifest(&canonical) {
        return Err("所选目录不是有效的连接器市场".into());
    }
    let metadata_dir = canonical
        .join(".echo-agent-connector")
        .canonicalize()
        .map_err(|error| format!("无法解析连接器 manifest 目录：{error}"))?;
    if metadata_dir.parent() != Some(canonical.as_path()) {
        return Err("连接器 manifest 目录越出市场根目录".into());
    }
    Ok(canonical)
}

/// Resolve exactly `<root>/connectors/<source>` and reject symlink/traversal
/// escapes. Connector CLI files are executable configuration, so simple
/// string joining is not an adequate trust boundary.
pub(crate) fn canonical_connector_dir(root: &str, source: &str) -> Result<PathBuf, String> {
    let root = canonical_marketplace_root(root)?;
    let source = validate_connector_source(source)?;
    let connectors = root.join("connectors");
    let connectors = connectors
        .canonicalize()
        .map_err(|error| format!("无法解析 connectors 目录：{error}"))?;
    if connectors.parent() != Some(root.as_path()) {
        return Err("connectors 目录越出市场根目录".into());
    }
    let directory = connectors
        .join(source)
        .canonicalize()
        .map_err(|error| format!("无法解析连接器目录：{error}"))?;
    if directory.parent() != Some(connectors.as_path()) || !directory.is_dir() {
        return Err("连接器目录越出市场边界".into());
    }
    Ok(directory)
}

/// CLI connector specifications are executable code. Permit execution only
/// from a backend-owned marketplace root (the EchoAgent data root, a legacy
/// compatible root, or an explicit process-start environment override).
/// A renderer-selected arbitrary browsing directory may still be inspected,
/// but it cannot become executable merely by invoking another command.
pub(crate) fn canonical_executable_connector_dir(
    root: &str,
    source: &str,
) -> Result<PathBuf, String> {
    let canonical_root = canonical_marketplace_root(root)?;
    let trusted = candidate_roots().into_iter().any(|candidate| {
        candidate
            .canonicalize()
            .is_ok_and(|candidate| candidate == canonical_root)
    });
    if !trusted {
        return Err(
            "拒绝执行未受信任目录中的 CLI 连接器；请将市场安装到 EchoAgent 数据目录，或在启动前设置 ECHO_AGENT_CONNECTORS_DIR"
                .into(),
        );
    }
    canonical_connector_dir(&canonical_root.to_string_lossy(), source)
}

fn read_small_file(path: &Path, max_bytes: u64, label: &str) -> Result<Vec<u8>, String> {
    crate::shell_fs::read_regular_file_bounded(path, max_bytes)
        .map_err(|error| format!("读取 {label} 失败：{error}"))
}

fn authorize_marketplace_root(
    access: &crate::shell_fs::FilesystemAccess,
    raw: &str,
) -> Result<PathBuf, String> {
    let canonical = canonical_marketplace_root(raw)?;
    let native_default = candidate_roots().into_iter().any(|candidate| {
        candidate
            .canonicalize()
            .is_ok_and(|candidate| candidate == canonical)
    });
    if !native_default {
        let authorized = access.require_workspace(raw)?;
        if authorized != canonical {
            return Err("连接器目录授权与实际路径不一致".into());
        }
    }
    Ok(canonical)
}

fn require_loaded_marketplace_root(raw: &str) -> Result<PathBuf, String> {
    let canonical = canonical_marketplace_root(raw)?;
    loaded_marketplace_roots()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains(&canonical)
        .then_some(canonical)
        .ok_or_else(|| "连接器市场尚未由后端加载".to_string())
}

/// Return the default data root (first existing candidate), or "" if none.
#[tauri::command]
pub async fn connectors_default_root() -> Result<String, String> {
    for r in candidate_roots() {
        if crate::paths::reject_legacy_workbuddy_path(&r).is_ok() && root_has_manifest(&r) {
            return Ok(r.to_string_lossy().into_owned());
        }
    }
    Ok(String::new())
}

/// Directories under `root` that look like a connector marketplace (have the
/// manifest). Used by the UI's "选择来源目录" picker to validate a selection.
#[tauri::command]
pub async fn connectors_list_roots(
    access: State<'_, crate::shell_fs::FilesystemAccess>,
    root: String,
) -> Result<Vec<String>, String> {
    let requested = PathBuf::from(&root);
    crate::paths::reject_legacy_workbuddy_path(&requested)?;
    let base = access.require_workspace(&root)?;
    let mut hits = Vec::new();
    if root_has_manifest(&base) {
        if let Ok(root) = canonical_marketplace_root(&base.to_string_lossy()) {
            hits.push(root.to_string_lossy().into_owned());
        }
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
            if let Ok(root) = canonical_marketplace_root(&p.to_string_lossy()) {
                if root.starts_with(&base) {
                    hits.push(root.to_string_lossy().into_owned());
                }
            }
        }
    }
    Ok(hits)
}

// ---------- load ----------

/// Parse the manifest at `<root>/.echo-agent-connector/connectors.json` and
/// build the connector list, resolving each icon to a local path.
#[tauri::command]
pub async fn connectors_load(
    access: State<'_, crate::shell_fs::FilesystemAccess>,
    root: Option<String>,
) -> Result<ConnectorCatalog, String> {
    let root = match root {
        Some(r) if !r.is_empty() => authorize_marketplace_root(&access, &r)?,
        _ => {
            let mut found = PathBuf::new();
            for r in candidate_roots() {
                if crate::paths::reject_legacy_workbuddy_path(&r).is_ok() && root_has_manifest(&r) {
                    found = r;
                    break;
                }
            }
            if found.as_os_str().is_empty() {
                return Err("未找到连接器数据目录（.echo-agent-connector/connectors.json）".into());
            }
            canonical_marketplace_root(&found.to_string_lossy())?
        }
    };
    load_connector_catalog(&root)
}

fn load_connector_catalog(root: &Path) -> Result<ConnectorCatalog, String> {
    let manifest_path = root.join(".echo-agent-connector").join("connectors.json");
    let bytes = read_small_file(&manifest_path, MAX_MANIFEST_BYTES, "manifest")?;
    let manifest: Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("解析 manifest 失败：{e}"))?;
    let mut loaded = loaded_marketplace_roots()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !loaded.contains(root) && loaded.len() >= MAX_LOADED_MARKETPLACE_ROOTS {
        return Err(format!(
            "本次运行最多加载 {MAX_LOADED_MARKETPLACE_ROOTS} 个连接器市场"
        ));
    }
    loaded.insert(root.to_path_buf());
    drop(loaded);

    let connectors = manifest
        .get("connectors")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| build_connector(root, e))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(ConnectorCatalog {
        root: root.to_string_lossy().into_owned(),
        categories: categories(),
        connectors,
    })
}

fn build_connector(root: &Path, e: &Value) -> Option<ConnectorItem> {
    let id = e.get("id")?.as_str()?.to_string();
    let source = e
        .get("source")
        .and_then(|v| v.as_str())
        .unwrap_or(&id)
        .to_string();
    if validate_connector_source(&source).is_err() {
        tracing::warn!(%source, "ignored connector with unsafe source path");
        return None;
    }
    let name = loc(&e.get("name").cloned().unwrap_or(Value::Null));
    let name = if name.is_empty() { id.clone() } else { name };
    let name_en = loc_str(e, "name_en");
    // Prefer the localized description; fall back to the generic one.
    let desc = {
        let dzh = loc_str(e, "description_zh");
        let d = loc(&e.get("description").cloned().unwrap_or(Value::Null));
        dzh.unwrap_or_else(|| if d.is_empty() { id.clone() } else { d })
    };
    let desc_en = loc_str(e, "description_en");
    let kind = match e.get("type").and_then(|v| v.as_str()).unwrap_or("") {
        "mcp" => "mcp".to_string(),
        "cli" => "cli".to_string(),
        "skill-only" | "skill_only" => "skill-only".to_string(),
        _ => "unknown".to_string(),
    };
    let auth_mode = loc_str(e, "auth_mode");
    let examples_zh = e
        .get("examples_zh")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .take(8)
                .collect()
        })
        .unwrap_or_default();
    let cat = derive_category(e);
    let icon_local = find_icon(root, &source);
    // Token-authorization connectors ship a `token-schema.json` next to the
    // mcp.json; load it so the frontend can render a fill-in form.
    let token_schema = read_token_schema(root, &source);
    Some(ConnectorItem {
        id,
        name,
        name_en,
        desc,
        desc_en,
        source,
        kind,
        auth_mode,
        examples_zh,
        cat,
        icon_local,
        token_schema,
    })
}

// ---------- icon reading ----------

fn b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Read a local icon file and return it as a `data:` URL (base64). SVG and PNG
/// are both small (a few KB), so no resizing is needed. Capped at 2 MB to keep
/// IPC sane.
#[tauri::command]
pub async fn connectors_icon(path: String) -> Result<String, String> {
    let src = PathBuf::from(&path);
    crate::paths::reject_legacy_workbuddy_path(&src)?;
    let metadata =
        std::fs::symlink_metadata(&src).map_err(|error| format!("读取图标失败：{error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("图标必须是已加载连接器市场内的普通文件".into());
    }
    if metadata.len() > MAX_ICON_BYTES {
        return Err("图标过大".into());
    }
    let canonical = src
        .canonicalize()
        .map_err(|error| format!("无法解析图标路径：{error}"))?;
    let allowed = loaded_marketplace_roots()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .any(|root| {
            root.join("icons")
                .canonicalize()
                .is_ok_and(|icons| canonical.parent() == Some(icons.as_path()))
        });
    if !allowed {
        return Err("图标路径不属于当前已加载的连接器市场".into());
    }
    let bytes = read_small_file(&canonical, MAX_ICON_BYTES, "图标")?;
    let mime = match src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => "application/octet-stream",
    };
    Ok(format!("data:{mime};base64,{}", b64(&bytes)))
}

// ---------- mcp config reading ----------

/// Read `<root>/connectors/<source>/mcp.json` and return its raw text, so the
/// detail modal can show the server config. Missing file yields "".
#[tauri::command]
pub async fn connectors_read_mcp_config(root: String, source: String) -> Result<String, String> {
    let root = require_loaded_marketplace_root(&root)?;
    let p = canonical_connector_dir(&root.to_string_lossy(), &source)?.join("mcp.json");
    if !p.is_file() {
        return Ok(String::new());
    }
    let bytes = read_small_file(&p, MAX_CONNECTOR_CONFIG_BYTES, "mcp.json")?;
    String::from_utf8(bytes).map_err(|e| format!("mcp.json 不是有效 UTF-8：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derive_category_classifies_correctly() {
        // token / server-side / oneid-token → "auth"
        let v = serde_json::json!({ "auth_mode": "token", "type": "mcp" });
        assert_eq!(derive_category(&v), "auth");
        let v = serde_json::json!({ "auth_mode": "server-side" });
        assert_eq!(derive_category(&v), "auth");
        // type-driven when no auth
        let v = serde_json::json!({ "type": "mcp" });
        assert_eq!(derive_category(&v), "mcp");
        let v = serde_json::json!({ "type": "cli" });
        assert_eq!(derive_category(&v), "cli");
        let v = serde_json::json!({ "type": "skill-only" });
        assert_eq!(derive_category(&v), "skill");
        // missing type → other
        let v = serde_json::json!({});
        assert_eq!(derive_category(&v), "other");
    }

    #[test]
    fn loc_picks_zh_then_en() {
        assert_eq!(loc(&serde_json::json!("plain")), "plain");
        assert_eq!(loc(&serde_json::json!({ "zh": "中", "en": "en" })), "中");
        assert_eq!(loc(&serde_json::json!({ "en": "only-en" })), "only-en");
        assert_eq!(loc(&serde_json::Value::Null), "");
    }

    #[test]
    fn connector_source_rejects_path_traversal() {
        for unsafe_source in ["", ".", "..", "../outside", "a/b", "a\\b", "line\nbreak"] {
            assert!(validate_connector_source(unsafe_source).is_err());
        }
        assert_eq!(
            validate_connector_source("github-enterprise").unwrap(),
            "github-enterprise"
        );
    }

    #[cfg(unix)]
    #[test]
    fn canonical_connector_dir_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("market");
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(root.join(".echo-agent-connector")).unwrap();
        std::fs::create_dir_all(root.join("connectors")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join(".echo-agent-connector/connectors.json"), "{}").unwrap();
        symlink(&outside, root.join("connectors/escaped")).unwrap();

        assert!(canonical_connector_dir(&root.to_string_lossy(), "escaped").is_err());
    }

    // ---- integration tests against the real echo-agent marketplace dir ----

    fn marketplace_available() -> bool {
        candidate_roots().iter().any(|root| root_has_manifest(root))
    }

    #[tokio::test]
    async fn load_returns_real_connectors() {
        if !marketplace_available() {
            eprintln!("[skip] EchoAgent connector marketplace not present");
            return;
        }
        let root = candidate_roots()
            .into_iter()
            .find(|root| root_has_manifest(root))
            .expect("marketplace root should exist");
        let root = canonical_marketplace_root(&root.to_string_lossy())
            .expect("marketplace root should be canonical");
        let catalog = load_connector_catalog(&root).expect("load should succeed");
        assert!(
            catalog.connectors.len() > 10,
            "expected many connectors, got {}",
            catalog.connectors.len()
        );
        // Every connector needs an id + non-empty desc + a resolved category.
        let mut with_icon = 0usize;
        for c in &catalog.connectors {
            assert!(!c.id.is_empty(), "connector with empty id");
            assert!(!c.desc.is_empty(), "connector {} has empty desc", c.id);
            assert!(!c.cat.is_empty(), "connector {} has empty cat", c.id);
            if c.icon_local.is_some() {
                with_icon += 1;
            }
        }
        // The real marketplace ships an icon per connector.
        assert_eq!(
            with_icon,
            catalog.connectors.len(),
            "expected every connector to have an icon"
        );
        // Token-mode connectors should carry their token-schema form.
        let with_token = catalog
            .connectors
            .iter()
            .filter(|c| c.token_schema.is_some())
            .count();
        assert!(
            with_token > 0,
            "expected at least one token-mode connector with a schema"
        );
        // Every token schema must have at least one field with a key.
        for c in catalog
            .connectors
            .iter()
            .filter(|c| c.token_schema.is_some())
        {
            let s = c.token_schema.as_ref().unwrap();
            assert!(
                !s.fields.is_empty(),
                "token schema for {} has no fields",
                c.id
            );
            assert!(
                s.fields.iter().all(|f| !f.key.is_empty()),
                "token field with empty key"
            );
        }
        eprintln!(
            "[ok] connectors_load: {} connectors, {} with token-schema, root={}",
            catalog.connectors.len(),
            with_token,
            catalog.root
        );
    }

    #[tokio::test]
    async fn default_root_finds_marketplace() {
        let root = connectors_default_root()
            .await
            .expect("default_root should not error");
        if !marketplace_available() {
            eprintln!("[skip] marketplace not present (root='{}')", root);
            return;
        }
        assert!(!root.is_empty(), "expected a non-empty default root");
        eprintln!("[ok] connectors_default_root: {}", root);
    }
}
