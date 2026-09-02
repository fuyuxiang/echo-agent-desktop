//! Multi-provider API key configuration.
//!
//! The runtime config in `~/.echo-agent/config.toml` supports two separate
//! concepts that together model "one provider, many models":
//!
//!   - `[model_providers.<id>]` — a connection/auth profile (base_url,
//!     api_key, api_backend, auth_scheme, context_window, extra_headers).
//!   - `[model.<id>]` — a single model catalog entry that may reference a
//!     provider via `model_provider = "<id>"`, inheriting its connection
//!     config. The runtime merges the provider defaults into each model in
//!     `resolve_model_list` (see vendor/.../config.rs).
//!
//! This is the runtime's preferred shape for BYOK: one key/url stored once per
//! provider, shared by every model that points at it. We expose a typed façade
//! over that file so the frontend can list/save without learning TOML or
//! the underlying schema.
//!
//! Storage rules:
//!   - Keys live in owner-only `config.toml`; `api_key` is the runtime's
//!     highest-priority credential source.
//!   - We **merge** rather than overwrite: any keys we don't recognize are
//!     preserved, so a user who hand-edits config.toml doesn't lose tweaks.
//!   - **Lazy migration**: legacy `[model.*]` tables that still carry their
//!     own `api_key`/`base_url` (the old "one table per model" shape) are
//!     grouped for *display* by base_url+api_key into synthetic providers,
//!     but the disk file is only rewritten when the user actively saves.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::State;
use toml::map::Map;
use toml::Value;

const ORGANIZATION_PROVIDER_ID: &str = "echoagent-organization";
const ORGANIZATION_MODEL_PREFIX: &str = "organization/";
const MANAGED_BY_KEY: &str = "echoagent_managed_by";
const MANAGED_BY_ORGANIZATION: &str = "organization";
const LABEL_KEY: &str = "echoagent_label";
const SYNCED_AT_KEY: &str = "echoagent_synced_at";
const LEASE_UNTIL_KEY: &str = "echoagent_lease_until";

// ---------------------------------------------------------------------------
// Built-in presets (endpoint + wire protocol per provider_kind).
// ---------------------------------------------------------------------------

/// Built-in preset: endpoint + wire protocol + auth header style per provider.
/// `base_url` is None for "custom-like" kinds (custom / custom_anthropic) where
/// the user must supply the endpoint, but the protocol/auth are still preset.
struct ProviderPreset {
    base_url: Option<&'static str>,
    api_backend: &'static str,
    auth_scheme: &'static str,
}

fn preset(kind: &str) -> Option<ProviderPreset> {
    match kind {
        "anthropic" => Some(ProviderPreset {
            base_url: Some("https://api.anthropic.com/v1"),
            api_backend: "messages",
            auth_scheme: "x_api_key",
        }),
        "openai" => Some(ProviderPreset {
            base_url: Some("https://api.openai.com/v1"),
            api_backend: "chat_completions",
            auth_scheme: "bearer",
        }),
        "deepseek" => Some(ProviderPreset {
            base_url: Some("https://api.deepseek.com"),
            api_backend: "chat_completions",
            auth_scheme: "bearer",
        }),
        "qwen" => Some(ProviderPreset {
            // 通义千问 OpenAI-compatible endpoint.
            base_url: Some("https://dashscope.aliyuncs.com/compatible-mode/v1"),
            api_backend: "chat_completions",
            auth_scheme: "bearer",
        }),
        // Anthropic-compatible custom endpoint: protocol/auth locked to the
        // Anthropic wire shape, but the user must supply base_url.
        "custom_anthropic" => Some(ProviderPreset {
            base_url: None,
            api_backend: "messages",
            auth_scheme: "x_api_key",
        }),
        // `custom` (OpenAI-compatible) intentionally has no preset at all —
        // caller must supply every field.
        _ => None,
    }
}

/// Reverse-map a provider by sniffing base_url + api_backend. Falls back to
/// `custom` for anything unrecognized so we never silently drop a user's entry.
fn infer_provider_kind(table: &Map<String, Value>) -> String {
    let backend = table
        .get("api_backend")
        .and_then(Value::as_str)
        .unwrap_or("");
    let base = table.get("base_url").and_then(Value::as_str).unwrap_or("");
    match backend {
        "messages" => {
            if base.contains("api.anthropic.com") {
                "anthropic".into()
            } else {
                "custom_anthropic".into()
            }
        }
        "chat_completions" | "responses" => {
            if base.contains("api.openai.com") {
                "openai".into()
            } else if base.contains("api.deepseek.com") {
                "deepseek".into()
            } else if base.contains("dashscope.aliyuncs.com") {
                "qwen".into()
            } else {
                "custom".into()
            }
        }
        _ => "custom".into(),
    }
}

/// Validate an api_backend value. Empty string (treat as "unset") is allowed.
fn validate_api_backend(v: &str) -> Result<(), String> {
    match v {
        "" | "chat_completions" | "responses" | "messages" => Ok(()),
        other => Err(format!(
            "invalid api_backend '{other}': must be chat_completions | responses | messages"
        )),
    }
}

/// Validate an auth_scheme value. Empty string (treat as "unset") is allowed.
fn validate_auth_scheme(v: &str) -> Result<(), String> {
    match v {
        "" | "bearer" | "x_api_key" => Ok(()),
        other => Err(format!(
            "invalid auth_scheme '{other}': must be bearer | x_api_key"
        )),
    }
}

// ---------------------------------------------------------------------------
// Config I/O (shared with sibling modules).
// ---------------------------------------------------------------------------

fn config_path() -> PathBuf {
    crate::paths::echo_agent_home_dir().join("config.toml")
}

/// Read config.toml as a TOML value, or an empty table if missing/corrupt.
/// (Corrupt → back up to `config.toml.corrupt.<millis>` so we don't silently
/// clobber the user's file.)
///
/// Exposed `pub(crate)` so sibling modules (permission_config) can reuse the
/// same atomic read-modify-write pattern without each re-implementing it.
pub(crate) fn read_config() -> Value {
    let path = config_path();
    match std::fs::read_to_string(&path) {
        Ok(s) => match s.parse::<Value>() {
            Ok(v) => v,
            Err(_) => {
                let _ = std::fs::rename(
                    &path,
                    path.with_extension(format!(
                        "toml.corrupt.{}",
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_millis())
                            .unwrap_or(0)
                    )),
                );
                Value::Table(Map::new())
            }
        },
        Err(_) => Value::Table(Map::new()),
    }
}

/// Atomic write: tmp file in the same dir, then rename. Falls back to direct
/// write if rename fails (e.g. antivirus interference) so we still make progress.
pub(crate) fn write_config(v: &Value) -> Result<(), String> {
    let path = config_path();
    let body = toml::to_string_pretty(v).map_err(|e| format!("serialize config: {e}"))?;
    crate::paths::write_private_file(&path, body.as_bytes())
}

// ---------------------------------------------------------------------------
// Frontend-facing data model: providers + models.
// ---------------------------------------------------------------------------

/// One connection/auth profile as the frontend sees it. Written to
/// `[model_providers.<id>]`. `api_key`: None = unchanged, Some("") = cleared,
/// Some("x") = set. When read back it is masked as `"••••"`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProviderEntry {
    /// The `[model_providers.<id>]` key; models reference it via
    /// `model_provider = "<id>"`. Stable id derived from provider_kind.
    pub id: String,
    /// `anthropic` | `openai` | `deepseek` | `qwen` | `custom`.
    pub provider_kind: String,
    /// User-facing connection name. EchoAgent stores it as desktop metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// The secret. None = unchanged, Some("") = cleared, Some("x") = set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_backend: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_scheme: Option<String>,
    /// Max context window in tokens. The runtime accepts this at the provider level
    /// (shared by all referencing models) — see ModelProviderConfig.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    /// `personal` | `organization` | `legacy`. Derived from stored metadata.
    #[serde(default)]
    pub source: String,
    /// Managed entries are read-only and can only be changed by org sync.
    #[serde(default)]
    pub managed: bool,
    /// Whether a usable credential is present without exposing the secret.
    #[serde(default)]
    pub credential_configured: bool,
    /// Organization sync timestamp in Unix milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub synced_at: Option<u64>,
    /// Original provider type sent by the organization server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization_provider: Option<String>,
}

/// One model catalog entry as the frontend sees it. Written to
/// `[model.<model_id>]` with a `model_provider` reference.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    /// Stable local catalog key used by EchoAgent sessions and selectors.
    pub model_id: String,
    /// Exact upstream model slug sent in requests. Defaults to `model_id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_model_id: Option<String>,
    /// References `[model_providers.<id>]`.
    pub provider_id: String,
    /// Human-readable display name (the runtime's `name` field, used in selectors).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Per-model context-window override (wins over the provider's value).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(default)]
    pub managed: bool,
}

/// The list result: every provider + every model, joined by `provider_id`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderListModel {
    pub providers: Vec<ModelProviderEntry>,
    pub models: Vec<ModelEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveConnectionResult {
    pub provider_id: String,
    pub model_ids: Vec<String>,
}

/// Complete chat configuration downloaded after organization sign-in.
///
/// It is intentionally written through the same config.toml schema as a
/// provider/model created in Settings, so the embedded Runtime needs no
/// organization-specific sampling path.
pub(crate) struct OrganizationModelConfig {
    pub provider: String,
    pub model: String,
    pub base_url: String,
    pub api_key: String,
    pub lease_until: u64,
}

// ---------------------------------------------------------------------------
// Read path (with lazy grouping of legacy per-model entries).
// ---------------------------------------------------------------------------

fn resolved_provider_api_key(table: &Map<String, Value>) -> Option<String> {
    table
        .get("api_key")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(String::from)
        .or_else(|| {
            let env_keys = table.get("env_key")?;
            let names = match env_keys {
                Value::String(name) => vec![name.as_str()],
                Value::Array(names) => names.iter().filter_map(Value::as_str).collect(),
                _ => Vec::new(),
            };
            names.into_iter().find_map(|name| {
                std::env::var(name)
                    .ok()
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
            })
        })
}

/// Mask helper: returns `Some("••••")` only when a static key or referenced
/// environment variable currently resolves to a non-empty credential.
fn masked_key(table: &Map<String, Value>) -> Option<String> {
    if resolved_provider_api_key(table).is_some() {
        Some("••••".into())
    } else {
        None
    }
}

/// Read a `[model_providers.<id>]` table into an entry. The api_key is masked.
fn provider_from_table(id: &str, table: &Map<String, Value>) -> ModelProviderEntry {
    let managed =
        table.get(MANAGED_BY_KEY).and_then(Value::as_str) == Some(MANAGED_BY_ORGANIZATION);
    let api_key = masked_key(table);
    ModelProviderEntry {
        id: id.to_string(),
        provider_kind: infer_provider_kind(table),
        label: table
            .get(LABEL_KEY)
            .and_then(Value::as_str)
            .map(String::from)
            .or_else(|| managed.then(|| "组织提供".to_string())),
        api_key: api_key.clone(),
        base_url: table
            .get("base_url")
            .and_then(Value::as_str)
            .map(String::from),
        api_backend: table
            .get("api_backend")
            .and_then(Value::as_str)
            .map(String::from),
        auth_scheme: table
            .get("auth_scheme")
            .and_then(Value::as_str)
            .map(String::from),
        context_window: table
            .get("context_window")
            .and_then(Value::as_integer)
            .map(|n| n as u64),
        source: if managed { "organization" } else { "personal" }.into(),
        managed,
        credential_configured: api_key.is_some(),
        synced_at: table
            .get(SYNCED_AT_KEY)
            .and_then(Value::as_integer)
            .map(|n| n as u64),
        organization_provider: table
            .get("organization_provider")
            .and_then(Value::as_str)
            .map(String::from),
    }
}

/// Group legacy `[model.*]` entries (those carrying their own key/url, i.e. the
/// old per-model shape) into synthetic providers keyed by `base_url|api_key`.
/// Returns (synthetic_providers, synthetic_models). Disk is NOT modified.
///
/// Each group's id is derived from its provider_kind, de-duplicated against the
/// `taken_ids` set so two different custom endpoints don't collide.
fn group_legacy_models(
    models: &Map<String, Value>,
    taken_ids: &mut std::collections::HashSet<String>,
) -> (Vec<ModelProviderEntry>, Vec<ModelEntry>) {
    // group_key -> (provider_kind, base_url, first table for field inference)
    use std::collections::BTreeMap;
    let mut groups: BTreeMap<String, (String, String)> = BTreeMap::new();
    let mut group_order: Vec<String> = Vec::new();
    // group_key -> [model_id]
    let mut members: BTreeMap<String, Vec<String>> = BTreeMap::new();

    for (model_id, v) in models {
        let Some(table) = v.as_table() else { continue };
        // Only legacy entries that carry their own connection config.
        let has_key = table.contains_key("api_key") || table.contains_key("env_key");
        let has_url = table.contains_key("base_url");
        if !has_key && !has_url {
            continue;
        }
        // Skip entries already migrated (they reference a provider).
        if table.contains_key("model_provider") {
            continue;
        }
        let base_url = table
            .get("base_url")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        // Keep distinct credentials/protocols in distinct synthetic groups.
        // The full signature stays in memory only and is never returned to the
        // frontend or logged.
        let credential_sig = table
            .get("api_key")
            .map(Value::to_string)
            .or_else(|| table.get("env_key").map(Value::to_string))
            .unwrap_or_else(|| "nokey".into());
        let backend_sig = table
            .get("api_backend")
            .map(Value::to_string)
            .unwrap_or_default();
        let auth_sig = table
            .get("auth_scheme")
            .map(Value::to_string)
            .unwrap_or_default();
        let group_key = format!("{base_url}|{credential_sig}|{backend_sig}|{auth_sig}");
        if !groups.contains_key(&group_key) {
            let kind = infer_provider_kind(table);
            groups.insert(group_key.clone(), (kind, base_url.clone()));
            group_order.push(group_key.clone());
        }
        members
            .entry(group_key.clone())
            .or_default()
            .push(model_id.clone());
    }

    let mut providers = Vec::new();
    let mut out_models = Vec::new();
    for gk in group_order {
        let (kind, base_url) = groups[&gk].clone();
        let id = allocate_provider_id(&kind, taken_ids);
        // Determine representative fields from the first member's table.
        let first_table = members[&gk]
            .first()
            .and_then(|mid| models.get(mid))
            .and_then(Value::as_table);
        providers.push(ModelProviderEntry {
            id: id.clone(),
            provider_kind: kind,
            label: None,
            api_key: first_table.and_then(|t| masked_key(t)),
            base_url: Some(base_url),
            api_backend: first_table
                .and_then(|t| t.get("api_backend"))
                .and_then(Value::as_str)
                .map(String::from),
            auth_scheme: first_table
                .and_then(|t| t.get("auth_scheme"))
                .and_then(Value::as_str)
                .map(String::from),
            context_window: first_table
                .and_then(|t| t.get("context_window"))
                .and_then(Value::as_integer)
                .map(|n| n as u64),
            source: "legacy".into(),
            managed: false,
            credential_configured: first_table.and_then(masked_key).is_some(),
            synced_at: None,
            organization_provider: None,
        });
        for mid in &members[&gk] {
            let table = models
                .get(mid)
                .and_then(Value::as_table)
                .expect("checked above");
            out_models.push(ModelEntry {
                model_id: mid.clone(),
                remote_model_id: table.get("model").and_then(Value::as_str).map(String::from),
                provider_id: id.clone(),
                name: table.get("name").and_then(Value::as_str).map(String::from),
                context_window: table
                    .get("context_window")
                    .and_then(Value::as_integer)
                    .map(|n| n as u64),
                managed: false,
            });
        }
    }
    (providers, out_models)
}

/// Locate the connection fields and members behind one synthetic legacy
/// provider id. This lets the new editor test and migrate old per-model config
/// without sending the original secret through the webview.
fn legacy_provider_details(config: &Value, provider_id: &str) -> Option<(Value, Vec<ModelEntry>)> {
    let providers = config.get("model_providers").and_then(Value::as_table);
    let mut taken = providers
        .map(|providers| providers.keys().cloned().collect())
        .unwrap_or_default();
    let model_tables = config.get("model").and_then(Value::as_table)?;
    let (legacy_providers, legacy_models) = group_legacy_models(model_tables, &mut taken);
    if !legacy_providers
        .iter()
        .any(|provider| provider.id == provider_id)
    {
        return None;
    }
    let members = legacy_models
        .into_iter()
        .filter(|model| model.provider_id == provider_id)
        .collect::<Vec<_>>();
    let representative = members
        .first()
        .and_then(|model| model_tables.get(&model.model_id))
        .and_then(Value::as_table)?;
    let mut connection = Map::new();
    for key in [
        "base_url",
        "api_base_url",
        "api_key",
        "env_key",
        "api_backend",
        "auth_scheme",
        "extra_headers",
        "query_params",
        "env_http_headers",
        "auth_provider",
        "auth",
        "context_window",
    ] {
        if let Some(value) = representative.get(key) {
            connection.insert(key.into(), value.clone());
        }
    }
    Some((Value::Table(connection), members))
}

/// Produce a stable, human-readable provider id that isn't already taken.
/// `openai`, then `openai-2`, `openai-3`, ... Inserts the chosen id into
/// `taken` so successive calls within one read don't collide.
fn allocate_provider_id(kind: &str, taken: &mut std::collections::HashSet<String>) -> String {
    if !taken.contains(kind) {
        taken.insert(kind.to_string());
        return kind.to_string();
    }
    let mut n = 2;
    loop {
        let candidate = format!("{kind}-{n}");
        if !taken.contains(&candidate) {
            taken.insert(candidate.clone());
            return candidate;
        }
        n += 1;
    }
}

fn stored_model_slug(model_id: &str, value: &Value) -> String {
    value
        .as_table()
        .and_then(|table| table.get("model"))
        .and_then(Value::as_str)
        .unwrap_or(model_id)
        .to_string()
}

fn allocate_model_id(
    remote_model_id: &str,
    provider_id: &str,
    models: &Map<String, Value>,
) -> String {
    if let Some((id, _)) = models.iter().find(|(id, value)| {
        value
            .as_table()
            .and_then(|table| table.get("model_provider"))
            .and_then(Value::as_str)
            == Some(provider_id)
            && stored_model_slug(id, value) == remote_model_id
    }) {
        return id.clone();
    }
    if !models.contains_key(remote_model_id) {
        return remote_model_id.to_string();
    }
    let base = format!("{provider_id}/{remote_model_id}");
    if !models.contains_key(&base) {
        return base;
    }
    let mut suffix = 2;
    loop {
        let candidate = format!("{base}-{suffix}");
        if !models.contains_key(&candidate) {
            return candidate;
        }
        suffix += 1;
    }
}

fn remove_unselected_provider_models(
    models: &mut Map<String, Value>,
    provider_id: &str,
    selected: &std::collections::HashSet<String>,
) -> Vec<String> {
    let stale = models
        .iter()
        .filter_map(|(model_id, value)| {
            let belongs_to_provider = value
                .as_table()
                .and_then(|table| table.get("model_provider"))
                .and_then(Value::as_str)
                == Some(provider_id);
            (belongs_to_provider && !selected.contains(model_id) && !is_organization_model(value))
                .then(|| model_id.clone())
        })
        .collect::<Vec<_>>();
    for model_id in &stale {
        models.remove(model_id);
    }
    stale
}

fn validate_personal_provider_target(config: &Value, provider_id: &str) -> Result<(), String> {
    if provider_id == ORGANIZATION_PROVIDER_ID {
        return Err("组织托管连接不能由本地设置修改".into());
    }
    let existing = config
        .get("model_providers")
        .and_then(Value::as_table)
        .and_then(|providers| providers.get(provider_id));
    if existing.is_some_and(is_organization_managed) {
        return Err("组织托管连接不能由本地设置修改".into());
    }
    Ok(())
}

fn validate_personal_model_target(config: &Value, model_id: &str) -> Result<(), String> {
    let existing = config
        .get("model")
        .and_then(Value::as_table)
        .and_then(|models| models.get(model_id));
    if existing.is_some_and(is_organization_model) {
        return Err("组织托管模型不能由本地设置修改".into());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Write helpers.
// ---------------------------------------------------------------------------

/// Resolve a single field using the priority chain:
///   explicit (non-empty Some) > existing disk value > preset default > error.
fn resolve_field(
    explicit: &Option<String>,
    existing: Option<&Value>,
    preset_val: Option<&'static str>,
    field_name: &str,
    is_custom: bool,
) -> Result<String, String> {
    if let Some(v) = explicit {
        if !v.is_empty() {
            return Ok(v.clone());
        }
    }
    if let Some(v) = existing.and_then(Value::as_str) {
        return Ok(v.to_string());
    }
    if let Some(p) = preset_val {
        return Ok(p.to_string());
    }
    if is_custom {
        Err(format!(
            "custom provider is missing required field '{field_name}' (set it in the Advanced section)"
        ))
    } else {
        Err(format!("internal error: no preset for {field_name}"))
    }
}

/// Render a `[model_providers.<id>]` table from an entry, preserving any
/// unrecognized keys already on disk.
fn provider_to_table(p: &ModelProviderEntry, existing: Option<&Value>) -> Result<Value, String> {
    let preset = preset(&p.provider_kind);
    // "Custom-like" kinds (custom / custom_anthropic) have no preset base_url,
    // so base_url must be user-supplied → a missing one is a hard error.
    let needs_base_url = preset.as_ref().and_then(|p| p.base_url).is_none();

    if let Some(b) = &p.api_backend {
        validate_api_backend(b)?;
    }
    if let Some(s) = &p.auth_scheme {
        validate_auth_scheme(s)?;
    }

    let mut table = match existing.and_then(Value::as_table) {
        Some(t) => t.clone(),
        None => Map::new(),
    };
    let existing_str = |key: &str| existing.and_then(Value::as_table).and_then(|t| t.get(key));

    let base_url = resolve_field(
        &p.base_url,
        existing_str("base_url"),
        preset.as_ref().and_then(|p| p.base_url),
        "base_url",
        needs_base_url,
    )?;
    let parsed_base_url = url::Url::parse(base_url.trim())
        .map_err(|error| format!("Base URL 格式不正确：{error}"))?;
    if !matches!(parsed_base_url.scheme(), "http" | "https") {
        return Err("Base URL 必须使用 HTTP 或 HTTPS".into());
    }
    let api_backend = resolve_field(
        &p.api_backend,
        existing_str("api_backend"),
        preset.as_ref().map(|p| p.api_backend),
        "api_backend",
        needs_base_url,
    )?;
    let auth_scheme = resolve_field(
        &p.auth_scheme,
        existing_str("auth_scheme"),
        preset.as_ref().map(|p| p.auth_scheme),
        "auth_scheme",
        needs_base_url,
    )?;

    table.insert("base_url".into(), Value::String(base_url));
    table.insert("api_backend".into(), Value::String(api_backend));
    table.insert("auth_scheme".into(), Value::String(auth_scheme));

    if let Some(label) = p.label.as_deref() {
        let label = label.trim();
        if label.is_empty() {
            table.remove(LABEL_KEY);
        } else {
            table.insert(LABEL_KEY.into(), Value::String(label.to_string()));
        }
    }

    if let Some(cw) = p.context_window {
        table.insert("context_window".into(), Value::Integer(cw as i64));
    } else {
        table.remove("context_window");
    }

    // Only touch api_key when the caller supplied one. Some("") clears it.
    if let Some(key) = &p.api_key {
        let key = key.trim();
        if key.is_empty() {
            table.remove("api_key");
        } else if key.starts_with('•') {
            // Mask coming back from the UI — treat as no-op.
        } else {
            table.insert("api_key".into(), Value::String(key.to_string()));
        }
    }

    Ok(Value::Table(table))
}

/// Render a `[model.<id>]` table from an entry. Connection config lives on the
/// provider now, so we strip any legacy base_url/api_key/api_backend/auth_scheme
/// the table may have carried (migration). Preserves unrecognized keys.
fn model_to_table(m: &ModelEntry, existing: Option<&Value>) -> Value {
    let mut table = match existing.and_then(Value::as_table) {
        Some(t) => t.clone(),
        None => Map::new(),
    };

    // The model slug the runtime will request. Defaults to the table key when absent.
    let remote_model_id = m
        .remote_model_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or(&m.model_id);
    table.insert("model".into(), Value::String(remote_model_id.to_string()));
    // Reference the provider for connection/auth config.
    table.insert(
        "model_provider".into(),
        Value::String(m.provider_id.clone()),
    );

    if let Some(name) = &m.name {
        if name.is_empty() {
            table.remove("name");
        } else {
            table.insert("name".into(), Value::String(name.clone()));
        }
    } else {
        table.remove("name");
    }

    if let Some(cw) = m.context_window {
        table.insert("context_window".into(), Value::Integer(cw as i64));
    } else {
        // Per-model override cleared → fall back to provider's value.
        table.remove("context_window");
    }

    // Migrate away legacy per-model connection fields (now on the provider).
    for k in [
        "base_url",
        "api_key",
        "api_backend",
        "auth_scheme",
        "env_key",
    ] {
        table.remove(k);
    }

    Value::Table(table)
}

/// Ensure a top-level table exists in the config root, returning a mut ref.
fn ensure_table<'a>(
    config: &'a mut Value,
    key: &str,
) -> Result<&'a mut Map<String, Value>, String> {
    let root = config
        .as_table_mut()
        .ok_or_else(|| format!("config root not a table"))?;
    if !root.contains_key(key) {
        root.insert(key.into(), Value::Table(Map::new()));
    }
    root.get_mut(key)
        .and_then(Value::as_table_mut)
        .ok_or_else(|| format!("config.{key} not a table"))
}

fn is_organization_managed(value: &Value) -> bool {
    value
        .as_table()
        .and_then(|table| table.get(MANAGED_BY_KEY))
        .and_then(Value::as_str)
        == Some(MANAGED_BY_ORGANIZATION)
}

fn is_organization_model(value: &Value) -> bool {
    is_organization_managed(value)
        || value
            .as_table()
            .and_then(|table| table.get("model_provider"))
            .and_then(Value::as_str)
            == Some(ORGANIZATION_PROVIDER_ID)
}

/// Apply a downloaded organization model to an in-memory config document.
/// Existing personal providers/models are preserved. A namespaced local model
/// id prevents a server model such as `gpt-4o` from replacing a user's own
/// entry; the nested `model` value remains the exact upstream model slug.
fn apply_organization_model_config(
    config: &mut Value,
    downloaded: &OrganizationModelConfig,
) -> Result<String, String> {
    let provider = downloaded.provider.trim();
    let model = downloaded.model.trim();
    let base_url = downloaded.base_url.trim().trim_end_matches('/');
    let api_key = downloaded.api_key.trim();
    if provider.is_empty() || model.is_empty() || base_url.is_empty() || api_key.is_empty() {
        return Err("organization model config is incomplete".into());
    }
    let parsed = url::Url::parse(base_url)
        .map_err(|error| format!("invalid organization model Base URL: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("organization model Base URL must use HTTP or HTTPS".into());
    }

    let normalized_provider = provider.to_ascii_lowercase();
    let provider_kind = match normalized_provider.as_str() {
        "openai" => "openai",
        "anthropic" => "anthropic",
        "deepseek" => "deepseek",
        "qwen" | "dashscope" => "qwen",
        "anthropic-compatible" | "anthropic_compatible" | "custom_anthropic" => "custom_anthropic",
        _ => "custom",
    };
    let provider_preset = preset(provider_kind);
    let api_backend = provider_preset
        .as_ref()
        .map(|preset| preset.api_backend)
        .unwrap_or("chat_completions");
    let auth_scheme = provider_preset
        .as_ref()
        .map(|preset| preset.auth_scheme)
        .unwrap_or("bearer");
    let synced_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let entry = ModelProviderEntry {
        id: ORGANIZATION_PROVIDER_ID.into(),
        provider_kind: provider_kind.into(),
        label: Some("组织提供".into()),
        api_key: Some(api_key.into()),
        base_url: Some(base_url.into()),
        api_backend: Some(api_backend.into()),
        auth_scheme: Some(auth_scheme.into()),
        context_window: None,
        source: "organization".into(),
        managed: true,
        credential_configured: true,
        synced_at: Some(synced_at),
        organization_provider: Some(provider.into()),
    };
    {
        let providers = ensure_table(config, "model_providers")?;
        let existing = providers.get(ORGANIZATION_PROVIDER_ID);
        let mut rendered = provider_to_table(&entry, existing)?;
        let table = rendered
            .as_table_mut()
            .ok_or("organization provider config is not a table")?;
        table.insert(
            MANAGED_BY_KEY.into(),
            Value::String(MANAGED_BY_ORGANIZATION.into()),
        );
        table.insert(
            "organization_provider".into(),
            Value::String(provider.into()),
        );
        table.insert(SYNCED_AT_KEY.into(), Value::Integer(synced_at as i64));
        table.insert(
            LEASE_UNTIL_KEY.into(),
            Value::Integer(downloaded.lease_until as i64),
        );
        providers.insert(ORGANIZATION_PROVIDER_ID.into(), rendered);
    }

    let model_id = format!("{ORGANIZATION_MODEL_PREFIX}{model}");
    {
        let models = ensure_table(config, "model")?;
        let stale: Vec<String> = models
            .iter()
            .filter_map(|(id, value)| is_organization_model(value).then(|| id.clone()))
            .collect();
        for id in stale {
            models.remove(&id);
        }

        let mut rendered = model_to_table(
            &ModelEntry {
                model_id: model_id.clone(),
                remote_model_id: Some(model.into()),
                provider_id: ORGANIZATION_PROVIDER_ID.into(),
                name: Some(model.into()),
                context_window: None,
                managed: true,
            },
            models.get(&model_id),
        );
        let table = rendered
            .as_table_mut()
            .ok_or("organization model config is not a table")?;
        // The table key is namespaced locally, while requests must use the
        // exact model slug configured by the organization administrator.
        table.insert("model".into(), Value::String(model.into()));
        models.insert(model_id.clone(), rendered);
    }

    Ok(model_id)
}

/// Persist a downloaded organization model alongside the user's own models.
pub(crate) fn save_organization_model_config(
    downloaded: OrganizationModelConfig,
) -> Result<String, String> {
    let mut config = read_config();
    let model_id = apply_organization_model_config(&mut config, &downloaded)?;
    write_config(&config)?;
    Ok(model_id)
}

/// Remove every organization-managed provider/model while preserving personal
/// connections. Used when the server disables chat configuration or the user
/// signs out, so downloaded credentials cannot outlive organization access.
pub(crate) fn remove_organization_model_config() -> Result<bool, String> {
    let mut config = read_config();
    let changed = remove_organization_model_config_from(&mut config);
    if changed {
        write_config(&config)?;
    }
    Ok(changed)
}

fn remove_organization_model_config_from(config: &mut Value) -> bool {
    let mut changed = false;
    let mut removed_model_ids = Vec::new();

    if let Some(providers) = config
        .as_table_mut()
        .and_then(|root| root.get_mut("model_providers"))
        .and_then(Value::as_table_mut)
    {
        let stale = providers
            .iter()
            .filter_map(|(id, value)| is_organization_managed(value).then(|| id.clone()))
            .collect::<Vec<_>>();
        for id in stale {
            changed |= providers.remove(&id).is_some();
        }
    }

    if let Some(models) = config
        .as_table_mut()
        .and_then(|root| root.get_mut("model"))
        .and_then(Value::as_table_mut)
    {
        let stale = models
            .iter()
            .filter_map(|(id, value)| is_organization_model(value).then(|| id.clone()))
            .collect::<Vec<_>>();
        for id in stale {
            if models.remove(&id).is_some() {
                removed_model_ids.push(id);
                changed = true;
            }
        }
    }

    if !removed_model_ids.is_empty() {
        if let Some(defaults) = config
            .as_table_mut()
            .and_then(|root| root.get_mut("models"))
            .and_then(Value::as_table_mut)
        {
            let selected = defaults.get("default").and_then(Value::as_str);
            if selected.is_some_and(|id| removed_model_ids.iter().any(|removed| removed == id)) {
                defaults.remove("default");
                changed = true;
            }
        }
    }

    changed
}

/// Fail closed after the signed organization policy lease expires. Temporary
/// network failures may keep the last downloaded configuration only while its
/// last verified policy is still valid.
pub(crate) fn enforce_organization_model_lease() -> Result<bool, String> {
    let config = read_config();
    let managed_provider = config
        .get("model_providers")
        .and_then(Value::as_table)
        .and_then(|providers| providers.get(ORGANIZATION_PROVIDER_ID))
        .filter(|provider| is_organization_managed(provider));
    let lease_until = managed_provider
        .and_then(Value::as_table)
        .and_then(|provider| provider.get(LEASE_UNTIL_KEY))
        .and_then(Value::as_integer)
        .map(|value| value as u64)
        .unwrap_or(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    if managed_provider.is_some() && lease_until <= now {
        remove_organization_model_config()
    } else {
        Ok(false)
    }
}

// ---------------------------------------------------------------------------
// Tauri commands.
// ---------------------------------------------------------------------------

/// List configured providers + models. Legacy per-model entries are grouped
/// into synthetic providers for display; disk is not modified.
#[tauri::command]
pub fn providers_list() -> ProviderListModel {
    let config = read_config();

    let mut providers = Vec::new();
    let mut models = Vec::new();
    let mut taken_ids = std::collections::HashSet::new();

    // 1) Real [model_providers.*] entries.
    if let Some(mps) = config
        .as_table()
        .and_then(|t| t.get("model_providers"))
        .and_then(Value::as_table)
    {
        for (id, v) in mps {
            let Some(table) = v.as_table() else { continue };
            taken_ids.insert(id.clone());
            providers.push(provider_from_table(id, table));
        }
    }

    // 2) Models that reference a provider.
    if let Some(mdls) = config
        .as_table()
        .and_then(|t| t.get("model"))
        .and_then(Value::as_table)
    {
        for (model_id, v) in mdls {
            let Some(table) = v.as_table() else { continue };
            if let Some(pid) = table.get("model_provider").and_then(Value::as_str) {
                models.push(ModelEntry {
                    model_id: model_id.clone(),
                    remote_model_id: table.get("model").and_then(Value::as_str).map(String::from),
                    provider_id: pid.to_string(),
                    name: table.get("name").and_then(Value::as_str).map(String::from),
                    context_window: table
                        .get("context_window")
                        .and_then(Value::as_integer)
                        .map(|n| n as u64),
                    managed: is_organization_model(v),
                });
            }
        }
    }

    // 3) Legacy per-model entries → grouped synthetic providers (display only).
    if let Some(mdls) = config
        .as_table()
        .and_then(|t| t.get("model"))
        .and_then(Value::as_table)
    {
        let (mut synth_p, mut synth_m) = group_legacy_models(mdls, &mut taken_ids);
        providers.append(&mut synth_p);
        models.append(&mut synth_m);
    }

    ProviderListModel { providers, models }
}

/// Return models whose referenced connection has both a valid HTTP(S) endpoint
/// and a stored credential. This powers the shell readiness gate so a dangling
/// model table no longer produces a false "ready" state.
pub(crate) fn usable_model_ids() -> (Vec<String>, Option<String>) {
    let list = providers_list();
    if list.models.is_empty() {
        return (
            Vec::new(),
            Some("尚未配置模型，请前往“设置 → 模型与连接”添加连接。".into()),
        );
    }
    let mut usable = Vec::new();
    for model in &list.models {
        let Some(provider) = list
            .providers
            .iter()
            .find(|provider| provider.id == model.provider_id)
        else {
            continue;
        };
        let endpoint_valid = provider
            .base_url
            .as_deref()
            .and_then(|base_url| url::Url::parse(base_url).ok())
            .is_some_and(|url| matches!(url.scheme(), "http" | "https"));
        let model_valid = !model
            .remote_model_id
            .as_deref()
            .unwrap_or(&model.model_id)
            .trim()
            .is_empty();
        if provider.credential_configured && endpoint_valid && model_valid {
            usable.push(model.model_id.clone());
        }
    }
    let reason = usable.is_empty().then(|| {
        "已有模型条目，但连接缺少有效的 Base URL 或 API Key，请在“设置 → 模型与连接”中修复。".into()
    });
    (usable, reason)
}

/// Save (merge) a provider into `[model_providers.<id>]`. Preserves unknown keys.
#[tauri::command]
pub fn providers_save_provider(
    _state: State<'_, crate::commands::AppState>,
    provider: ModelProviderEntry,
) -> Result<(), String> {
    if provider.id.trim().is_empty() {
        return Err("provider id 不能为空".into());
    }
    let mut config = read_config();
    validate_personal_provider_target(&config, provider.id.trim())?;
    let mps = ensure_table(&mut config, "model_providers")?;
    let existing = mps.get(&provider.id);
    let rendered = provider_to_table(&provider, existing)?;
    mps.insert(provider.id.clone(), rendered);
    write_config(&config)
}

/// Atomically save a connection and the models selected during discovery.
/// An empty provider id allocates a collision-free id such as `custom-2`.
#[tauri::command]
pub fn providers_save_connection(
    _state: State<'_, crate::commands::AppState>,
    mut provider: ModelProviderEntry,
    mut models: Vec<ModelEntry>,
    replace_models: bool,
) -> Result<SaveConnectionResult, String> {
    let mut config = read_config();
    let legacy = (provider.source == "legacy")
        .then(|| legacy_provider_details(&config, provider.id.trim()))
        .flatten();
    let provider_id = if provider.id.trim().is_empty() {
        let mut taken = config
            .get("model_providers")
            .and_then(Value::as_table)
            .map(|providers| providers.keys().cloned().collect())
            .unwrap_or_default();
        allocate_provider_id(provider.provider_kind.trim(), &mut taken)
    } else {
        provider.id.trim().to_string()
    };
    if provider.provider_kind.trim().is_empty() {
        return Err("请选择接口类型".into());
    }
    validate_personal_provider_target(&config, &provider_id)?;
    provider.id.clone_from(&provider_id);
    provider.managed = false;
    provider.source = "personal".into();

    {
        let providers = ensure_table(&mut config, "model_providers")?;
        let existing = providers
            .get(&provider_id)
            .or_else(|| legacy.as_ref().map(|(connection, _)| connection));
        let rendered = provider_to_table(&provider, existing)?;
        let credential_configured = rendered
            .as_table()
            .and_then(resolved_provider_api_key)
            .is_some();
        if !credential_configured {
            return Err("请填写 API Key".into());
        }
        providers.insert(provider_id.clone(), rendered);
    }

    // Saving any part of a legacy connection migrates all of its existing
    // members unless the caller explicitly chose a replacement set.
    if !replace_models {
        if let Some((_, legacy_models)) = &legacy {
            let supplied = models
                .iter()
                .map(|model| model.model_id.clone())
                .collect::<std::collections::HashSet<_>>();
            models.extend(
                legacy_models
                    .iter()
                    .filter(|model| !supplied.contains(&model.model_id))
                    .cloned(),
            );
        }
    }

    let mut model_ids = Vec::with_capacity(models.len());
    let removed_model_ids = {
        let model_tables = ensure_table(&mut config, "model")?;
        for mut model in models {
            let remote_model_id = model
                .remote_model_id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .or_else(|| {
                    let id = model.model_id.trim();
                    (!id.is_empty()).then_some(id)
                })
                .ok_or("模型 ID 不能为空")?
                .to_string();
            let local_id = if model.model_id.trim().is_empty() {
                allocate_model_id(&remote_model_id, &provider_id, model_tables)
            } else {
                model.model_id.trim().to_string()
            };
            if model_tables
                .get(&local_id)
                .is_some_and(is_organization_model)
            {
                return Err("组织托管模型不能由本地设置修改".into());
            }
            if let Some(other_provider) = model_tables
                .get(&local_id)
                .and_then(Value::as_table)
                .and_then(|table| table.get("model_provider"))
                .and_then(Value::as_str)
                .filter(|existing| *existing != provider_id)
            {
                return Err(format!(
                    "模型目录 ID「{local_id}」已属于连接「{other_provider}」"
                ));
            }
            model.model_id.clone_from(&local_id);
            model.remote_model_id = Some(remote_model_id);
            model.provider_id.clone_from(&provider_id);
            model.managed = false;
            let rendered = model_to_table(&model, model_tables.get(&local_id));
            model_tables.insert(local_id.clone(), rendered);
            model_ids.push(local_id);
        }
        if replace_models {
            let selected = model_ids.iter().cloned().collect();
            remove_unselected_provider_models(model_tables, &provider_id, &selected)
        } else {
            Vec::new()
        }
    };

    if !removed_model_ids.is_empty() {
        if let Some(defaults) = config
            .as_table_mut()
            .and_then(|root| root.get_mut("models"))
            .and_then(Value::as_table_mut)
        {
            let selected = defaults.get("default").and_then(Value::as_str);
            if selected.is_some_and(|id| removed_model_ids.iter().any(|removed| removed == id)) {
                defaults.remove("default");
            }
        }
    }

    write_config(&config)?;
    Ok(SaveConnectionResult {
        provider_id,
        model_ids,
    })
}

/// Save a model into `[model.<model_id>]` with a `model_provider` reference.
/// Migrates the entry away from legacy per-model connection fields.
#[tauri::command]
pub fn providers_save_model(
    _state: State<'_, crate::commands::AppState>,
    mut model: ModelEntry,
) -> Result<String, String> {
    if model.provider_id.trim().is_empty() {
        return Err("provider_id 不能为空".into());
    }
    let mut config = read_config();
    validate_personal_provider_target(&config, model.provider_id.trim())?;
    let remote_model_id = model
        .remote_model_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .or_else(|| {
            let id = model.model_id.trim();
            (!id.is_empty()).then_some(id)
        })
        .ok_or("模型 ID 不能为空")?
        .to_string();
    let mdls = ensure_table(&mut config, "model")?;
    let local_id = if model.model_id.trim().is_empty() {
        allocate_model_id(&remote_model_id, model.provider_id.trim(), mdls)
    } else {
        model.model_id.trim().to_string()
    };
    if mdls.get(&local_id).is_some_and(is_organization_model) {
        return Err("组织托管模型不能由本地设置修改".into());
    }
    model.model_id.clone_from(&local_id);
    model.remote_model_id = Some(remote_model_id);
    model.managed = false;
    let existing = mdls.get(&local_id);
    let rendered = model_to_table(&model, existing);
    mdls.insert(local_id.clone(), rendered);
    write_config(&config)?;
    Ok(local_id)
}

/// Delete a provider AND every model that references it.
#[tauri::command]
pub fn providers_delete_provider(id: String) -> Result<(), String> {
    let mut config = read_config();
    validate_personal_provider_target(&config, id.trim())?;

    // Remove the provider table.
    let removed_provider = config
        .as_table_mut()
        .and_then(|t| t.get_mut("model_providers"))
        .and_then(Value::as_table_mut)
        .and_then(|m| m.remove(&id))
        .is_some();

    // Cascade: drop every [model.*] referencing it.
    let mut cascaded = 0usize;
    let mut removed_model_ids = Vec::new();
    if let Some(mdls) = config
        .as_table_mut()
        .and_then(|t| t.get_mut("model"))
        .and_then(Value::as_table_mut)
    {
        let stale: Vec<String> = mdls
            .iter()
            .filter_map(|(mid, v)| {
                let refs = v
                    .as_table()
                    .and_then(|t| t.get("model_provider"))
                    .and_then(Value::as_str);
                if refs == Some(id.as_str()) {
                    Some(mid.clone())
                } else {
                    None
                }
            })
            .collect();
        for mid in stale {
            if mdls.remove(&mid).is_some() {
                removed_model_ids.push(mid);
                cascaded += 1;
            }
        }
    }

    if let Some(defaults) = config
        .as_table_mut()
        .and_then(|root| root.get_mut("models"))
        .and_then(Value::as_table_mut)
    {
        let selected = defaults.get("default").and_then(Value::as_str);
        if selected.is_some_and(|model_id| removed_model_ids.iter().any(|id| id == model_id)) {
            defaults.remove("default");
        }
    }

    if removed_provider || cascaded > 0 {
        write_config(&config)?;
    }
    Ok(())
}

/// Delete a single model entry.
#[tauri::command]
pub fn providers_delete_model(model_id: String) -> Result<(), String> {
    let mut config = read_config();
    validate_personal_model_target(&config, model_id.trim())?;
    let removed = config
        .as_table_mut()
        .and_then(|t| t.get_mut("model"))
        .and_then(Value::as_table_mut)
        .and_then(|m| m.remove(&model_id))
        .is_some();
    if removed {
        if let Some(defaults) = config
            .as_table_mut()
            .and_then(|root| root.get_mut("models"))
            .and_then(Value::as_table_mut)
        {
            if defaults.get("default").and_then(Value::as_str) == Some(model_id.as_str()) {
                defaults.remove("default");
            }
        }
        write_config(&config)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Back-compat shims (deprecated). Keep the old command names registered so a
// stale frontend build doesn't hit "unknown command" at runtime; they no-op.
// ---------------------------------------------------------------------------

/// Deprecated: use `providers_save_provider` / `providers_save_model`.
#[tauri::command]
pub fn providers_save(
    _state: State<'_, crate::commands::AppState>,
    _providers: Vec<serde_json::Value>,
) -> Result<(), String> {
    Err("providers_save is deprecated; use providers_save_provider / providers_save_model".into())
}

/// Deprecated: use `providers_delete_model`.
#[tauri::command]
pub fn providers_delete(_model_id: String) -> Result<(), String> {
    Err("providers_delete is deprecated; use providers_delete_model".into())
}

// ---------------------------------------------------------------------------
// Remote model discovery.
// ---------------------------------------------------------------------------

/// One model entry returned by a provider's `GET /models` endpoint.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedModel {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owned_by: Option<String>,
}

/// Resolve the effective base_url for a fetch, given the provider kind and an
/// optional override. Presets provide the default; `custom` requires the caller
/// to supply `base_url`.
fn resolve_fetch_base_url(kind: &str, base_url: &Option<String>) -> Result<String, String> {
    if let Some(url) = base_url {
        let trimmed = url.trim().trim_end_matches('/');
        if trimmed.is_empty() {
            return Err("base_url 不能为空".into());
        }
        return Ok(trimmed.to_string());
    }
    match preset(kind).and_then(|p| p.base_url) {
        Some(b) => Ok(b.trim_end_matches('/').to_string()),
        None => Err("自定义提供商必须填写 Base URL".into()),
    }
}

/// Fetch the list of available models from a provider's `/models` endpoint.
///
/// Works for any OpenAI-compatible endpoint (`GET {base_url}/models` returning
/// `{"data":[{"id":"...","owned_by":"..."}]}`) and for Anthropic (same path,
/// but requires `anthropic-version` header + `x-api-key` auth).
///
/// The `api_key` is used only for this single request — it is never persisted
/// or logged.
#[tauri::command]
pub async fn providers_fetch_models(
    provider_kind: String,
    api_key: String,
    base_url: Option<String>,
) -> Result<Vec<FetchedModel>, String> {
    fetch_models(&provider_kind, &api_key, &base_url, None).await
}

/// Fetch models using an already-saved provider credential. The secret stays
/// inside native code, so Settings never asks users to re-enter it or exposes
/// organization-managed keys to the webview.
#[tauri::command]
pub async fn providers_fetch_models_for_provider(
    provider_id: String,
) -> Result<Vec<FetchedModel>, String> {
    let config = read_config();
    let table = config
        .get("model_providers")
        .and_then(Value::as_table)
        .and_then(|providers| providers.get(provider_id.trim()))
        .and_then(Value::as_table)
        .ok_or("连接不存在")?;
    let provider_kind = infer_provider_kind(table);
    let api_key = resolved_provider_api_key(table).ok_or("该连接没有可用的已保存 API Key")?;
    let base_url = table
        .get("base_url")
        .and_then(Value::as_str)
        .map(String::from);
    let auth_scheme = table.get("auth_scheme").and_then(Value::as_str);
    fetch_models(&provider_kind, &api_key, &base_url, auth_scheme).await
}

/// Validate an unsaved connection draft. When editing and the key is blank or
/// masked, reuse the existing native-side secret without sending it to React.
#[tauri::command]
pub async fn providers_test_connection(
    provider: ModelProviderEntry,
) -> Result<Vec<FetchedModel>, String> {
    let config = read_config();
    if !provider.id.trim().is_empty() {
        validate_personal_provider_target(&config, provider.id.trim())?;
    }
    let legacy_existing = (provider.source == "legacy")
        .then(|| legacy_provider_details(&config, provider.id.trim()))
        .flatten()
        .map(|(connection, _)| connection);
    let existing = (!provider.id.trim().is_empty())
        .then(|| {
            config
                .get("model_providers")
                .and_then(Value::as_table)
                .and_then(|providers| providers.get(provider.id.trim()))
        })
        .flatten()
        .or(legacy_existing.as_ref());
    let rendered = provider_to_table(&provider, existing)?;
    let table = rendered.as_table().ok_or("连接配置无效")?;
    let provider_kind = infer_provider_kind(table);
    let api_key = resolved_provider_api_key(table).ok_or("请填写 API Key")?;
    let base_url = table
        .get("base_url")
        .and_then(Value::as_str)
        .map(String::from);
    let auth_scheme = table.get("auth_scheme").and_then(Value::as_str);
    fetch_models(&provider_kind, &api_key, &base_url, auth_scheme).await
}

/// Test the actual inference endpoint with a concrete model id. This is kept
/// separate from model discovery because many OpenAI/Anthropic-compatible
/// gateways intentionally do not expose `GET /models`.
#[tauri::command]
pub async fn providers_test_model_connection(
    provider: ModelProviderEntry,
    model_id: String,
) -> Result<(), String> {
    let model_id = model_id.trim();
    if model_id.is_empty() {
        return Err("请填写 Model ID".into());
    }

    let config = read_config();
    let stored = (!provider.id.trim().is_empty())
        .then(|| {
            config
                .get("model_providers")
                .and_then(Value::as_table)
                .and_then(|providers| providers.get(provider.id.trim()))
        })
        .flatten();

    // Organization-managed connections are tested exactly as downloaded;
    // never accept webview-provided overrides for their endpoint or secret.
    let rendered = if stored.is_some_and(is_organization_managed) {
        stored.cloned().ok_or("连接不存在")?
    } else {
        if !provider.id.trim().is_empty() {
            validate_personal_provider_target(&config, provider.id.trim())?;
        }
        let legacy_existing = (provider.source == "legacy")
            .then(|| legacy_provider_details(&config, provider.id.trim()))
            .flatten()
            .map(|(connection, _)| connection);
        let existing = stored.or(legacy_existing.as_ref());
        provider_to_table(&provider, existing)?
    };

    let table = rendered.as_table().ok_or("连接配置无效")?;
    let provider_kind = infer_provider_kind(table);
    let api_key = resolved_provider_api_key(table).ok_or("请填写 API Key")?;
    let base_url = table
        .get("base_url")
        .and_then(Value::as_str)
        .map(String::from);
    let api_backend = table
        .get("api_backend")
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            preset(&provider_kind)
                .map(|provider| provider.api_backend)
                .unwrap_or("chat_completions")
        });
    let auth_scheme = table.get("auth_scheme").and_then(Value::as_str);
    test_model_inference(
        &provider_kind,
        &api_key,
        &base_url,
        api_backend,
        auth_scheme,
        model_id,
    )
    .await
}

fn inference_endpoint(base: &str, api_backend: &str) -> Result<String, String> {
    validate_api_backend(api_backend)?;
    let path = match api_backend {
        "responses" => "responses",
        "messages" => "messages",
        _ => "chat/completions",
    };
    let base = base.trim().trim_end_matches('/');
    if base.ends_with(path) {
        Ok(base.to_string())
    } else {
        Ok(format!("{base}/{path}"))
    }
}

async fn test_model_inference(
    provider_kind: &str,
    api_key: &str,
    base_url: &Option<String>,
    api_backend: &str,
    explicit_auth_scheme: Option<&str>,
    model_id: &str,
) -> Result<(), String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err("请先填写 API Key".into());
    }

    let base = resolve_fetch_base_url(provider_kind, base_url)?;
    let url = inference_endpoint(&base, api_backend)?;
    let auth_scheme = explicit_auth_scheme
        .map(str::trim)
        .filter(|scheme| !scheme.is_empty())
        .map(str::to_string)
        .or_else(|| preset(provider_kind).map(|provider| provider.auth_scheme.to_string()))
        .unwrap_or_else(|| "bearer".into());
    validate_auth_scheme(&auth_scheme)?;

    let payload = match api_backend {
        "responses" => serde_json::json!({
            "model": model_id,
            "input": "Reply with OK.",
            "max_output_tokens": 16,
            "stream": false
        }),
        "messages" => serde_json::json!({
            "model": model_id,
            "max_tokens": 1,
            "messages": [{ "role": "user", "content": "Reply with OK." }],
            "stream": false
        }),
        _ => serde_json::json!({
            "model": model_id,
            "messages": [{ "role": "user", "content": "Reply with OK." }],
            "stream": false
        }),
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| format!("创建 HTTP 客户端失败：{error}"))?;
    let mut request = client.post(&url).json(&payload);
    request = match auth_scheme.as_str() {
        "x_api_key" => request
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01"),
        _ => request.header("Authorization", format!("Bearer {key}")),
    };

    let response = request
        .send()
        .await
        .map_err(|error| format!("请求模型失败：{error}"))?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }

    let body = response.text().await.unwrap_or_default();
    let snippet = body.chars().take(300).collect::<String>();
    Err(if snippet.trim().is_empty() {
        format!("模型接口返回 {status}")
    } else {
        format!("模型接口返回 {status}：{snippet}")
    })
}

async fn fetch_models(
    provider_kind: &str,
    api_key: &str,
    base_url: &Option<String>,
    explicit_auth_scheme: Option<&str>,
) -> Result<Vec<FetchedModel>, String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err("请先填写 API Key".into());
    }

    let base = resolve_fetch_base_url(provider_kind, base_url)?;
    let auth_scheme = explicit_auth_scheme
        .map(str::trim)
        .filter(|scheme| !scheme.is_empty())
        .map(str::to_string)
        .or_else(|| preset(provider_kind).map(|p| p.auth_scheme.to_string()))
        .unwrap_or_else(|| "bearer".into());
    validate_auth_scheme(&auth_scheme)?;

    let url = format!("{base}/models");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败：{e}"))?;

    let mut req = client.get(&url);
    // Auth header per the provider's scheme.
    req = match auth_scheme.as_str() {
        "x_api_key" => req
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01"),
        _ => req.header("Authorization", format!("Bearer {key}")),
    };

    let resp = req.send().await.map_err(|e| format!("请求失败：{e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let snippet = if body.len() > 200 {
            format!(
                "{}…",
                &body[..body
                    .char_indices()
                    .take(200)
                    .last()
                    .map(|(i, _)| i)
                    .unwrap_or(200)]
            )
        } else {
            body
        };
        return Err(format!("API 返回 {status}：{snippet}"));
    }

    // Parse the OpenAI-compatible `{ "data": [{ "id": "…", "owned_by": "…" }] }` shape.
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析响应失败（非 JSON）：{e}"))?;

    let data = json
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or_else(|| "响应缺少 data 数组（该端点可能不支持 /models 列表）".to_string())?;

    let models = data
        .iter()
        .filter_map(|item| {
            let id = item.get("id").and_then(|v| v.as_str())?.to_string();
            if id.is_empty() {
                return None;
            }
            let owned_by = item
                .get("owned_by")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            Some(FetchedModel { id, owned_by })
        })
        .collect::<Vec<_>>();

    Ok(models)
}

// ---------------------------------------------------------------------------
// Unit tests.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // --- infer_provider_kind ---

    #[test]
    fn infer_anthropic_from_messages_backend() {
        let mut table = Map::new();
        table.insert("api_backend".into(), Value::String("messages".into()));
        table.insert(
            "base_url".into(),
            Value::String("https://api.anthropic.com/v1".into()),
        );
        assert_eq!(infer_provider_kind(&table), "anthropic");
    }

    #[test]
    fn infer_openai() {
        let mut table = Map::new();
        table.insert(
            "api_backend".into(),
            Value::String("chat_completions".into()),
        );
        table.insert(
            "base_url".into(),
            Value::String("https://api.openai.com/v1".into()),
        );
        assert_eq!(infer_provider_kind(&table), "openai");
    }

    #[test]
    fn infer_custom_for_unknown() {
        let mut table = Map::new();
        table.insert(
            "api_backend".into(),
            Value::String("chat_completions".into()),
        );
        table.insert(
            "base_url".into(),
            Value::String("https://my-custom.api/v1".into()),
        );
        assert_eq!(infer_provider_kind(&table), "custom");
    }

    // --- allocate_provider_id ---

    #[test]
    fn allocate_id_first_use() {
        let mut taken = std::collections::HashSet::new();
        assert_eq!(allocate_provider_id("openai", &mut taken), "openai");
        assert!(taken.contains("openai"));
    }

    #[test]
    fn allocate_id_dedup_suffix() {
        let mut taken = std::collections::HashSet::new();
        taken.insert("custom".into());
        assert_eq!(allocate_provider_id("custom", &mut taken), "custom-2");
        assert_eq!(allocate_provider_id("custom", &mut taken), "custom-3");
    }

    // --- provider_to_table (new shape) ---

    #[test]
    fn provider_to_table_anthropic_preset() {
        let p = ModelProviderEntry {
            id: "anthropic".into(),
            provider_kind: "anthropic".into(),
            label: None,
            api_key: Some("sk-ant-test".into()),
            base_url: None,
            api_backend: None,
            auth_scheme: None,
            context_window: Some(200_000),
            ..Default::default()
        };
        let result = provider_to_table(&p, None).unwrap();
        let table = result.as_table().unwrap();
        assert_eq!(
            table["base_url"].as_str().unwrap(),
            "https://api.anthropic.com/v1"
        );
        assert_eq!(table["api_backend"].as_str().unwrap(), "messages");
        assert_eq!(table["auth_scheme"].as_str().unwrap(), "x_api_key");
        assert_eq!(table["api_key"].as_str().unwrap(), "sk-ant-test");
        assert_eq!(table["context_window"].as_integer().unwrap(), 200_000);
    }

    #[test]
    fn provider_to_table_masked_key_is_noop() {
        let mut existing = Map::new();
        existing.insert(
            "base_url".into(),
            Value::String("https://api.openai.com/v1".into()),
        );
        existing.insert(
            "api_backend".into(),
            Value::String("chat_completions".into()),
        );
        existing.insert("auth_scheme".into(), Value::String("bearer".into()));
        existing.insert("api_key".into(), Value::String("real-key".into()));

        let p = ModelProviderEntry {
            id: "openai".into(),
            provider_kind: "openai".into(),
            label: None,
            api_key: Some("••••".into()),
            base_url: None,
            api_backend: None,
            auth_scheme: None,
            context_window: None,
            ..Default::default()
        };
        let table = provider_to_table(&p, Some(&Value::Table(existing))).unwrap();
        assert_eq!(
            table.as_table().unwrap()["api_key"].as_str().unwrap(),
            "real-key"
        );
    }

    #[test]
    fn provider_to_table_custom_missing_field_errors() {
        let p = ModelProviderEntry {
            id: "custom".into(),
            provider_kind: "custom".into(),
            label: None,
            api_key: None,
            base_url: None,
            api_backend: None,
            auth_scheme: None,
            context_window: None,
            ..Default::default()
        };
        assert!(provider_to_table(&p, None).is_err());
    }

    // --- model_to_table (migration strips legacy connection fields) ---

    #[test]
    fn model_to_table_sets_reference_and_strips_legacy_fields() {
        let mut existing = Map::new();
        // Legacy per-model connection fields that must be removed on migration.
        existing.insert(
            "base_url".into(),
            Value::String("https://api.openai.com/v1".into()),
        );
        existing.insert("api_key".into(), Value::String("sk-old".into()));
        existing.insert(
            "api_backend".into(),
            Value::String("chat_completions".into()),
        );
        existing.insert("auth_scheme".into(), Value::String("bearer".into()));
        // Unrecognized key preserved.
        existing.insert("temperature".into(), Value::String("0.5".into()));

        let m = ModelEntry {
            model_id: "gpt-4o".into(),
            provider_id: "openai".into(),
            name: Some("GPT-4o".into()),
            context_window: None,
            ..Default::default()
        };
        let table = model_to_table(&m, Some(&Value::Table(existing)))
            .as_table()
            .unwrap()
            .clone();

        assert_eq!(table["model"].as_str().unwrap(), "gpt-4o");
        assert_eq!(table["model_provider"].as_str().unwrap(), "openai");
        assert_eq!(table["name"].as_str().unwrap(), "GPT-4o");
        // Legacy connection fields stripped.
        assert!(!table.contains_key("base_url"));
        assert!(!table.contains_key("api_key"));
        assert!(!table.contains_key("api_backend"));
        assert!(!table.contains_key("auth_scheme"));
        // Unrecognized key preserved.
        assert_eq!(table["temperature"].as_str().unwrap(), "0.5");
    }

    #[test]
    fn model_to_table_per_model_context_window_override() {
        let m = ModelEntry {
            model_id: "gpt-4o".into(),
            provider_id: "openai".into(),
            name: None,
            context_window: Some(128_000),
            ..Default::default()
        };
        let table = model_to_table(&m, None).as_table().unwrap().clone();
        assert_eq!(table["context_window"].as_integer().unwrap(), 128_000);
    }

    #[test]
    fn model_to_table_keeps_local_id_separate_from_remote_slug() {
        let model = ModelEntry {
            model_id: "custom-2/shared-model".into(),
            remote_model_id: Some("shared-model".into()),
            provider_id: "custom-2".into(),
            ..Default::default()
        };
        let table = model_to_table(&model, None);
        assert_eq!(table["model"].as_str(), Some("shared-model"));
        assert_eq!(table["model_provider"].as_str(), Some("custom-2"));
    }

    #[test]
    fn allocate_model_id_namespaces_cross_provider_collision() {
        let mut models = Map::new();
        let mut first = Map::new();
        first.insert("model".into(), Value::String("shared-model".into()));
        first.insert("model_provider".into(), Value::String("first".into()));
        models.insert("shared-model".into(), Value::Table(first));

        assert_eq!(
            allocate_model_id("shared-model", "second", &models),
            "second/shared-model"
        );
    }

    #[test]
    fn replacing_connection_models_removes_only_unselected_models_from_that_connection() {
        let mut models = Map::new();
        for (local_id, provider_id) in [
            ("keep", "personal"),
            ("remove", "personal"),
            ("other", "other-provider"),
        ] {
            models.insert(
                local_id.into(),
                Value::Table(Map::from_iter([
                    ("model".into(), Value::String(local_id.into())),
                    ("model_provider".into(), Value::String(provider_id.into())),
                ])),
            );
        }

        let removed = remove_unselected_provider_models(
            &mut models,
            "personal",
            &std::collections::HashSet::from(["keep".to_string()]),
        );

        assert_eq!(removed, vec!["remove"]);
        assert!(models.contains_key("keep"));
        assert!(!models.contains_key("remove"));
        assert!(models.contains_key("other"));
    }

    #[test]
    fn organization_model_config_preserves_personal_entries_and_uses_exact_model_slug() {
        let mut root = Map::new();
        let mut personal_provider = Map::new();
        personal_provider.insert(
            "base_url".into(),
            Value::String("https://personal.example/v1".into()),
        );
        personal_provider.insert("api_key".into(), Value::String("sk-personal".into()));
        let mut providers = Map::new();
        providers.insert("personal".into(), Value::Table(personal_provider));
        root.insert("model_providers".into(), Value::Table(providers));

        let mut personal_model = Map::new();
        personal_model.insert("model".into(), Value::String("glm-5".into()));
        personal_model.insert("model_provider".into(), Value::String("personal".into()));
        let mut models = Map::new();
        models.insert("glm-5".into(), Value::Table(personal_model));
        root.insert("model".into(), Value::Table(models));

        let mut config = Value::Table(root);
        let local_id = apply_organization_model_config(
            &mut config,
            &OrganizationModelConfig {
                provider: "openai-compatible".into(),
                model: "glm-5".into(),
                base_url: "https://organization.example/v1/".into(),
                api_key: "sk-organization".into(),
                lease_until: u64::MAX,
            },
        )
        .unwrap();

        assert_eq!(local_id, "organization/glm-5");
        let root = config.as_table().unwrap();
        let providers = root["model_providers"].as_table().unwrap();
        assert_eq!(
            providers["personal"]["api_key"].as_str(),
            Some("sk-personal")
        );
        let organization = providers[ORGANIZATION_PROVIDER_ID].as_table().unwrap();
        assert_eq!(
            organization["base_url"].as_str(),
            Some("https://organization.example/v1")
        );
        assert_eq!(organization["api_key"].as_str(), Some("sk-organization"));
        assert_eq!(
            organization["api_backend"].as_str(),
            Some("chat_completions")
        );
        assert_eq!(organization["auth_scheme"].as_str(), Some("bearer"));

        let models = root["model"].as_table().unwrap();
        assert!(models.contains_key("glm-5"));
        let organization_model = models["organization/glm-5"].as_table().unwrap();
        assert_eq!(organization_model["model"].as_str(), Some("glm-5"));
        assert_eq!(
            organization_model["model_provider"].as_str(),
            Some(ORGANIZATION_PROVIDER_ID)
        );
    }

    #[test]
    fn organization_model_config_replaces_only_the_previous_downloaded_model() {
        let mut config = Value::Table(Map::new());
        for model in ["old-model", "new-model"] {
            apply_organization_model_config(
                &mut config,
                &OrganizationModelConfig {
                    provider: "openai".into(),
                    model: model.into(),
                    base_url: "https://api.openai.com/v1".into(),
                    api_key: format!("sk-{model}"),
                    lease_until: u64::MAX,
                },
            )
            .unwrap();
        }

        let models = config.get("model").and_then(Value::as_table).unwrap();
        assert!(!models.contains_key("organization/old-model"));
        assert!(models.contains_key("organization/new-model"));
        let provider = config
            .get("model_providers")
            .and_then(Value::as_table)
            .and_then(|providers| providers.get(ORGANIZATION_PROVIDER_ID))
            .and_then(Value::as_table)
            .unwrap();
        assert_eq!(provider["api_key"].as_str(), Some("sk-new-model"));
    }

    #[test]
    fn organization_cleanup_preserves_personal_entries_and_clears_default() {
        let mut config = Value::Table(Map::new());
        apply_organization_model_config(
            &mut config,
            &OrganizationModelConfig {
                provider: "openai".into(),
                model: "managed-model".into(),
                base_url: "https://organization.example/v1".into(),
                api_key: "sk-managed".into(),
                lease_until: u64::MAX,
            },
        )
        .unwrap();
        config["model_providers"].as_table_mut().unwrap().insert(
            "personal".into(),
            Value::Table(Map::from_iter([
                (
                    "base_url".into(),
                    Value::String("https://personal.example/v1".into()),
                ),
                ("api_key".into(), Value::String("sk-personal".into())),
            ])),
        );
        config["model"].as_table_mut().unwrap().insert(
            "personal-model".into(),
            Value::Table(Map::from_iter([
                ("model".into(), Value::String("personal-model".into())),
                ("model_provider".into(), Value::String("personal".into())),
            ])),
        );
        config.as_table_mut().unwrap().insert(
            "models".into(),
            Value::Table(Map::from_iter([(
                "default".into(),
                Value::String("organization/managed-model".into()),
            )])),
        );

        assert!(remove_organization_model_config_from(&mut config));
        assert!(config["model_providers"].get("personal").is_some());
        assert!(config["model"].get("personal-model").is_some());
        assert!(config["model_providers"]
            .get(ORGANIZATION_PROVIDER_ID)
            .is_none());
        assert!(config["model"].get("organization/managed-model").is_none());
        assert!(config["models"].get("default").is_none());
    }

    // --- group_legacy_models (lazy migration, display only) ---

    #[test]
    fn group_legacy_merges_same_endpoint_into_one_provider() {
        let mut models = Map::new();
        for (mid, key) in [
            ("gpt-4o", "sk-aaa"),
            ("gpt-4o-mini", "sk-aaa"),
            ("claude-sonnet-4-5", "sk-ant-bbb"),
        ] {
            let mut entry = Map::new();
            let is_anthropic = mid.starts_with("claude");
            entry.insert(
                "base_url".into(),
                Value::String(
                    if is_anthropic {
                        "https://api.anthropic.com/v1"
                    } else {
                        "https://api.openai.com/v1"
                    }
                    .into(),
                ),
            );
            entry.insert(
                "api_backend".into(),
                Value::String(
                    if is_anthropic {
                        "messages"
                    } else {
                        "chat_completions"
                    }
                    .into(),
                ),
            );
            entry.insert("api_key".into(), Value::String(key.into()));
            models.insert(mid.into(), Value::Table(entry));
        }

        let mut taken = std::collections::HashSet::new();
        let (providers, out_models) = group_legacy_models(&models, &mut taken);

        // Two provider groups (openai + anthropic), three models total.
        assert_eq!(providers.len(), 2);
        assert_eq!(out_models.len(), 3);
        // Each model references one of the synthetic providers.
        let pids: Vec<String> = providers.iter().map(|p| p.id.clone()).collect();
        assert!(pids.contains(&"openai".to_string()));
        assert!(pids.contains(&"anthropic".to_string()));
        // Models grouped under the matching provider.
        for m in &out_models {
            if m.model_id.starts_with("gpt") {
                assert_eq!(m.provider_id, "openai");
            } else {
                assert_eq!(m.provider_id, "anthropic");
            }
        }
        // Disk-like input map is unchanged (display-only grouping).
        assert_eq!(models.len(), 3);
        assert!(models["gpt-4o"].as_table().unwrap().contains_key("api_key"));
    }

    #[test]
    fn group_legacy_keeps_different_credentials_separate() {
        let mut models = Map::new();
        for (model_id, api_key) in [("model-a", "sk-a"), ("model-b", "sk-b")] {
            models.insert(
                model_id.into(),
                Value::Table(Map::from_iter([
                    (
                        "base_url".into(),
                        Value::String("https://gateway.example/v1".into()),
                    ),
                    ("api_key".into(), Value::String(api_key.into())),
                    (
                        "api_backend".into(),
                        Value::String("chat_completions".into()),
                    ),
                ])),
            );
        }

        let mut taken = std::collections::HashSet::new();
        let (providers, grouped_models) = group_legacy_models(&models, &mut taken);
        assert_eq!(providers.len(), 2);
        assert_eq!(grouped_models.len(), 2);
        assert_ne!(grouped_models[0].provider_id, grouped_models[1].provider_id);
    }

    #[test]
    fn legacy_provider_details_keeps_secret_native_for_transparent_migration() {
        let mut config = Value::Table(Map::new());
        config.as_table_mut().unwrap().insert(
            "model".into(),
            Value::Table(Map::from_iter([(
                "legacy-model".into(),
                Value::Table(Map::from_iter([
                    (
                        "base_url".into(),
                        Value::String("https://legacy.example/v1".into()),
                    ),
                    ("api_key".into(), Value::String("sk-legacy".into())),
                    (
                        "api_backend".into(),
                        Value::String("chat_completions".into()),
                    ),
                ])),
            )])),
        );

        let (connection, members) = legacy_provider_details(&config, "custom").unwrap();
        assert_eq!(connection["api_key"].as_str(), Some("sk-legacy"));
        assert_eq!(connection["base_url"].as_str(), Some("https://legacy.example/v1"));
        assert_eq!(members.len(), 1);
        assert_eq!(members[0].model_id, "legacy-model");
    }

    #[test]
    fn group_legacy_skips_migrated_entries() {
        let mut models = Map::new();
        let mut migrated = Map::new();
        migrated.insert("model_provider".into(), Value::String("openai".into()));
        models.insert("gpt-4o".into(), Value::Table(migrated));

        let mut taken = std::collections::HashSet::new();
        let (providers, out_models) = group_legacy_models(&models, &mut taken);
        assert!(providers.is_empty());
        assert!(out_models.is_empty());
    }

    #[test]
    fn group_legacy_dedups_custom_ids() {
        let mut models = Map::new();
        for (mid, url) in [
            ("m1", "https://endpoint-a/v1"),
            ("m2", "https://endpoint-b/v1"),
        ] {
            let mut entry = Map::new();
            entry.insert("base_url".into(), Value::String(url.into()));
            entry.insert(
                "api_backend".into(),
                Value::String("chat_completions".into()),
            );
            entry.insert("api_key".into(), Value::String("k".into()));
            models.insert(mid.into(), Value::Table(entry));
        }
        let mut taken = std::collections::HashSet::new();
        let (providers, _) = group_legacy_models(&models, &mut taken);
        let ids: Vec<String> = providers.iter().map(|p| p.id.clone()).collect();
        assert!(ids.contains(&"custom".to_string()));
        assert!(ids.contains(&"custom-2".to_string()));
    }

    // --- providers_list round-trip over a synthetic config ---

    #[test]
    fn providers_list_reads_new_format_and_legacy() {
        let mut config = Map::new();

        // New-format provider + referencing model.
        let mut mp = Map::new();
        mp.insert(
            "base_url".into(),
            Value::String("https://api.openai.com/v1".into()),
        );
        mp.insert(
            "api_backend".into(),
            Value::String("chat_completions".into()),
        );
        mp.insert("auth_scheme".into(), Value::String("bearer".into()));
        mp.insert("api_key".into(), Value::String("sk-xxx".into()));
        mp.insert("context_window".into(), Value::Integer(128_000));
        let mut mps = Map::new();
        mps.insert("openai".into(), Value::Table(mp));
        config.insert("model_providers".into(), Value::Table(mps));

        let mut model = Map::new();
        model.insert("model".into(), Value::String("gpt-4o".into()));
        model.insert("model_provider".into(), Value::String("openai".into()));
        model.insert("name".into(), Value::String("GPT-4o".into()));
        let mut mdls = Map::new();
        mdls.insert("gpt-4o".into(), Value::Table(model));

        // Legacy per-model entry (no model_provider).
        let mut legacy = Map::new();
        legacy.insert(
            "base_url".into(),
            Value::String("https://api.anthropic.com/v1".into()),
        );
        legacy.insert("api_backend".into(), Value::String("messages".into()));
        legacy.insert("api_key".into(), Value::String("sk-ant".into()));
        mdls.insert("claude-sonnet-4-5".into(), Value::Table(legacy));

        config.insert("model".into(), Value::Table(mdls));

        let v = Value::Table(config);
        // Reconstruct a ProviderListModel the same way providers_list does.
        let mut providers = Vec::new();
        let mut models = Vec::new();
        let mut taken = std::collections::HashSet::new();
        let root = v.as_table().unwrap();
        if let Some(mps) = root.get("model_providers").and_then(Value::as_table) {
            for (id, t) in mps {
                if let Some(tbl) = t.as_table() {
                    taken.insert(id.clone());
                    providers.push(provider_from_table(id, tbl));
                }
            }
        }
        if let Some(mdls) = root.get("model").and_then(Value::as_table) {
            for (mid, t) in mdls {
                let Some(tbl) = t.as_table() else { continue };
                if let Some(pid) = tbl.get("model_provider").and_then(Value::as_str) {
                    models.push(ModelEntry {
                        model_id: mid.clone(),
                        provider_id: pid.to_string(),
                        name: tbl.get("name").and_then(Value::as_str).map(String::from),
                        context_window: tbl
                            .get("context_window")
                            .and_then(Value::as_integer)
                            .map(|n| n as u64),
                        ..Default::default()
                    });
                }
            }
            let (mut sp, mut sm) = group_legacy_models(mdls, &mut taken);
            providers.append(&mut sp);
            models.append(&mut sm);
        }

        // One real provider (openai, with context_window) + one legacy group (anthropic).
        assert_eq!(providers.len(), 2);
        let openai = providers.iter().find(|p| p.id == "openai").unwrap();
        assert_eq!(openai.context_window, Some(128_000));
        assert_eq!(openai.api_key.as_deref(), Some("••••"));
        // gpt-4o references openai; claude-sonnet-4-5 references the legacy group.
        assert_eq!(models.len(), 2);
        let gpt = models.iter().find(|m| m.model_id == "gpt-4o").unwrap();
        assert_eq!(gpt.provider_id, "openai");
        assert_eq!(gpt.name.as_deref(), Some("GPT-4o"));
        let claude = models
            .iter()
            .find(|m| m.model_id == "claude-sonnet-4-5")
            .unwrap();
        assert_eq!(claude.provider_id, "anthropic");
    }

    // --- resolve_field ---

    #[test]
    fn resolve_field_explicit_wins() {
        let result = resolve_field(
            &Some("https://custom.api".into()),
            Some(&Value::String("https://old.api".into())),
            Some("https://preset.api"),
            "base_url",
            false,
        );
        assert_eq!(result.unwrap(), "https://custom.api");
    }

    #[test]
    fn resolve_field_preset_fallback() {
        let result = resolve_field(&None, None, Some("https://preset.api"), "base_url", false);
        assert_eq!(result.unwrap(), "https://preset.api");
    }

    #[test]
    fn resolve_field_custom_missing_errors() {
        let result = resolve_field(&None, None, None, "base_url", true);
        assert!(result.is_err());
    }

    // --- validate helpers ---

    #[test]
    fn validate_backend_and_scheme() {
        assert!(validate_api_backend("chat_completions").is_ok());
        assert!(validate_api_backend("graphql").is_err());
        assert!(validate_auth_scheme("bearer").is_ok());
        assert!(validate_auth_scheme("basic").is_err());
    }

    #[test]
    fn preset_known_kinds() {
        assert!(preset("anthropic").is_some());
        assert!(preset("custom").is_none());
    }

    #[test]
    fn preset_custom_anthropic_has_protocol_but_no_base_url() {
        // custom_anthropic locks protocol/auth to the Anthropic wire shape but
        // has no base_url preset (user must supply the endpoint).
        let p = preset("custom_anthropic").expect("custom_anthropic has a preset");
        assert_eq!(p.base_url, None);
        assert_eq!(p.api_backend, "messages");
        assert_eq!(p.auth_scheme, "x_api_key");
    }

    #[test]
    fn provider_to_table_custom_anthropic_requires_base_url() {
        // No base_url supplied and none in the preset → hard error.
        let p = ModelProviderEntry {
            id: "custom_anthropic".into(),
            provider_kind: "custom_anthropic".into(),
            label: None,
            api_key: Some("sk-ant-test".into()),
            base_url: None,
            api_backend: None,
            auth_scheme: None,
            context_window: None,
            ..Default::default()
        };
        assert!(provider_to_table(&p, None).is_err());
    }

    #[test]
    fn provider_to_table_custom_anthropic_with_base_url_uses_anthropic_protocol() {
        let p = ModelProviderEntry {
            id: "custom_anthropic".into(),
            provider_kind: "custom_anthropic".into(),
            label: None,
            api_key: Some("sk-ant-test".into()),
            base_url: Some("https://my-anthropic-proxy/v1".into()),
            api_backend: None, // should fall back to preset "messages"
            auth_scheme: None, // should fall back to preset "x_api_key"
            context_window: None,
            ..Default::default()
        };
        let table = provider_to_table(&p, None).unwrap();
        let t = table.as_table().unwrap();
        assert_eq!(
            t["base_url"].as_str().unwrap(),
            "https://my-anthropic-proxy/v1"
        );
        assert_eq!(t["api_backend"].as_str().unwrap(), "messages");
        assert_eq!(t["auth_scheme"].as_str().unwrap(), "x_api_key");
        assert_eq!(t["api_key"].as_str().unwrap(), "sk-ant-test");
    }

    #[test]
    fn inference_endpoint_uses_protocol_path_without_duplication() {
        assert_eq!(
            inference_endpoint("https://api.example.com/v1", "chat_completions").unwrap(),
            "https://api.example.com/v1/chat/completions"
        );
        assert_eq!(
            inference_endpoint(
                "https://api.example.com/v1/chat/completions/",
                "chat_completions"
            )
            .unwrap(),
            "https://api.example.com/v1/chat/completions"
        );
        assert_eq!(
            inference_endpoint("https://api.example.com/v1", "responses").unwrap(),
            "https://api.example.com/v1/responses"
        );
        assert_eq!(
            inference_endpoint("https://api.example.com/v1", "messages").unwrap(),
            "https://api.example.com/v1/messages"
        );
        assert!(inference_endpoint("https://api.example.com/v1", "graphql").is_err());
    }
}
