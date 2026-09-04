//! Agent-level runtime config — reads/writes the embedded runtime's `[subagents]` and
//! `[models] web_search` config blocks.
//!
//! These are knobs that affect how the agent builds its toolset at startup,
//! so (like permission rules) an EchoAgent restart is required for changes to take
//! effect. We reuse `providers.rs`'s atomic `read_config`/`write_config`.
//!
//! ```toml
//! [subagents]
//! max_depth = 2          # nesting depth (default 1)
//!
//! [models]
//! web_search = "search-model"  # set to enable web_search tool; remove to disable
//!
//! [memory]
//! enabled = true
//! [memory.initial_injection]
//! enabled = true
//! [memory.session]
//! save_on_end = true
//! [memory.watcher]
//! enabled = true
//! [memory.dream]
//! enabled = true
//! [compaction.memory_flush]
//! enabled = true
//! ```

use serde::{Deserialize, Serialize};
use toml::Value;

// ---------------------------------------------------------------------------
// Subagents
// ---------------------------------------------------------------------------

/// `[subagents]` config as the frontend sees it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentsConfig {
    /// Maximum subagent nesting depth (≥1). The runtime default is 1.
    pub max_depth: i64,
}

/// Read `[subagents].max_depth` from config.toml. Returns the default value 1
/// when the key is absent.
#[tauri::command]
pub fn subagents_config_get() -> SubagentsConfig {
    let config = crate::providers::read_config();
    let max_depth = config
        .get("subagents")
        .and_then(Value::as_table)
        .and_then(|t| t.get("max_depth"))
        .and_then(Value::as_integer)
        .unwrap_or(1);
    SubagentsConfig { max_depth }
}

/// Write `[subagents].max_depth`. Clamped to ≥1. Returns the clamped value.
/// Requires an EchoAgent restart to take effect.
#[tauri::command]
pub fn subagents_config_save(max_depth: i64) -> Result<i64, String> {
    let clamped = if max_depth < 1 { 1 } else { max_depth };
    let mut config = crate::providers::read_config();
    let subagents = config
        .as_table_mut()
        .map(|t| {
            t.entry("subagents")
                .or_insert_with(|| Value::Table(Default::default()))
        })
        .and_then(Value::as_table_mut)
        .ok_or_else(|| "config root is not a table".to_string())?;
    subagents.insert("max_depth".to_string(), Value::Integer(clamped));
    crate::providers::write_config(&config)?;
    Ok(clamped)
}

// ---------------------------------------------------------------------------
// Web search
// ---------------------------------------------------------------------------

/// `[models] web_search` config as the frontend sees it.
/// `enabled` is derived: true when a web_search model is set.
/// `model` is the configured model id (empty string = none).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchConfig {
    pub enabled: bool,
    pub model: String,
}

/// Read the web_search model from `[models].web_search`.
#[tauri::command]
pub fn web_search_config_get() -> WebSearchConfig {
    let config = crate::providers::read_config();
    let model = config
        .get("models")
        .and_then(Value::as_table)
        .and_then(|t| t.get("web_search"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    WebSearchConfig {
        enabled: !model.is_empty(),
        model,
    }
}

/// Enable/disable web search by setting/clearing `[models].web_search`.
///
/// When enabling, `model` must be a non-empty model id (it will be stored
/// verbatim). When disabling, the key is removed. Requires an EchoAgent restart.
#[tauri::command]
pub fn web_search_config_save(enable: bool, model: Option<String>) -> Result<bool, String> {
    let mut config = crate::providers::read_config();
    let models = config
        .as_table_mut()
        .map(|t| {
            t.entry("models")
                .or_insert_with(|| Value::Table(Default::default()))
        })
        .and_then(Value::as_table_mut)
        .ok_or_else(|| "config root is not a table".to_string())?;
    if enable {
        let mid = model.unwrap_or_default().trim().to_string();
        if mid.is_empty() {
            return Err("enabling web_search requires a model id".to_string());
        }
        models.insert("web_search".to_string(), Value::String(mid));
    } else {
        models.remove("web_search");
    }
    crate::providers::write_config(&config)?;
    Ok(enable)
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/// User-facing controls for the embedded Runtime's local memory system.
///
/// EchoAgent intentionally defaults these features on. The upstream Runtime
/// defaults the top-level `memory.enabled` flag off, so `agent_runtime` passes
/// our resolved value as an explicit host override during startup.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryConfig {
    pub enabled: bool,
    pub initial_injection_enabled: bool,
    pub save_on_end: bool,
    pub watcher_enabled: bool,
    pub auto_flush_enabled: bool,
    pub dream_enabled: bool,
}

impl Default for MemoryConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            initial_injection_enabled: true,
            save_on_end: true,
            watcher_enabled: true,
            auto_flush_enabled: true,
            dream_enabled: true,
        }
    }
}

fn nested_bool(config: &Value, table: &str, key: &str, default: bool) -> bool {
    config
        .get(table)
        .and_then(Value::as_table)
        .and_then(|value| value.get(key))
        .and_then(Value::as_bool)
        .unwrap_or(default)
}

fn doubly_nested_bool(config: &Value, table: &str, nested: &str, key: &str, default: bool) -> bool {
    config
        .get(table)
        .and_then(Value::as_table)
        .and_then(|value| value.get(nested))
        .and_then(Value::as_table)
        .and_then(|value| value.get(key))
        .and_then(Value::as_bool)
        .unwrap_or(default)
}

pub(crate) fn resolved_memory_config(config: &Value) -> MemoryConfig {
    let defaults = MemoryConfig::default();
    MemoryConfig {
        enabled: nested_bool(config, "memory", "enabled", defaults.enabled),
        initial_injection_enabled: doubly_nested_bool(
            config,
            "memory",
            "initial_injection",
            "enabled",
            defaults.initial_injection_enabled,
        ),
        save_on_end: doubly_nested_bool(
            config,
            "memory",
            "session",
            "save_on_end",
            defaults.save_on_end,
        ),
        watcher_enabled: doubly_nested_bool(
            config,
            "memory",
            "watcher",
            "enabled",
            defaults.watcher_enabled,
        ),
        auto_flush_enabled: doubly_nested_bool(
            config,
            "compaction",
            "memory_flush",
            "enabled",
            defaults.auto_flush_enabled,
        ),
        dream_enabled: doubly_nested_bool(
            config,
            "memory",
            "dream",
            "enabled",
            defaults.dream_enabled,
        ),
    }
}

#[tauri::command]
pub fn memory_config_get() -> MemoryConfig {
    resolved_memory_config(&crate::providers::read_config())
}

fn set_nested_bool(
    root: &mut Value,
    table: &str,
    nested: Option<&str>,
    key: &str,
    value: bool,
) -> Result<(), String> {
    let table = root
        .as_table_mut()
        .map(|root| {
            root.entry(table)
                .or_insert_with(|| Value::Table(Default::default()))
        })
        .and_then(Value::as_table_mut)
        .ok_or_else(|| "config root is not a table".to_string())?;

    let target = if let Some(nested) = nested {
        table
            .entry(nested)
            .or_insert_with(|| Value::Table(Default::default()))
            .as_table_mut()
            .ok_or_else(|| format!("config section {nested} is not a table"))?
    } else {
        table
    };
    target.insert(key.to_string(), Value::Boolean(value));
    Ok(())
}

/// Persist all memory controls in one atomic config write. A running session
/// keeps its existing memory backend; the new configuration applies after the
/// Agent Runtime is restarted.
#[tauri::command]
pub fn memory_config_save(memory: MemoryConfig) -> Result<MemoryConfig, String> {
    let mut config = crate::providers::read_config();
    set_nested_bool(&mut config, "memory", None, "enabled", memory.enabled)?;
    set_nested_bool(
        &mut config,
        "memory",
        Some("initial_injection"),
        "enabled",
        memory.initial_injection_enabled,
    )?;
    set_nested_bool(
        &mut config,
        "memory",
        Some("session"),
        "save_on_end",
        memory.save_on_end,
    )?;
    set_nested_bool(
        &mut config,
        "memory",
        Some("watcher"),
        "enabled",
        memory.watcher_enabled,
    )?;
    set_nested_bool(
        &mut config,
        "memory",
        Some("dream"),
        "enabled",
        memory.dream_enabled,
    )?;
    set_nested_bool(
        &mut config,
        "compaction",
        Some("memory_flush"),
        "enabled",
        memory.auto_flush_enabled,
    )?;
    crate::providers::write_config(&config)?;
    Ok(memory)
}

#[cfg(test)]
mod memory_tests {
    use super::*;

    #[test]
    fn memory_defaults_are_enabled_for_echoagent() {
        let config = Value::Table(Default::default());
        assert_eq!(resolved_memory_config(&config), MemoryConfig::default());
    }

    #[test]
    fn memory_config_resolves_each_nested_setting() {
        let config: Value = toml::from_str(
            r#"
                [memory]
                enabled = false
                [memory.initial_injection]
                enabled = false
                [memory.session]
                save_on_end = false
                [memory.watcher]
                enabled = false
                [memory.dream]
                enabled = false
                [compaction.memory_flush]
                enabled = false
            "#,
        )
        .unwrap();
        assert_eq!(
            resolved_memory_config(&config),
            MemoryConfig {
                enabled: false,
                initial_injection_enabled: false,
                save_on_end: false,
                watcher_enabled: false,
                auto_flush_enabled: false,
                dream_enabled: false,
            }
        );
    }

    #[test]
    fn set_nested_bool_preserves_unrelated_config() {
        let mut config: Value = toml::from_str("[models]\ndefault = 'demo'\n").unwrap();
        set_nested_bool(&mut config, "memory", Some("session"), "save_on_end", true).unwrap();
        assert_eq!(config["models"]["default"].as_str(), Some("demo"));
        assert_eq!(
            config["memory"]["session"]["save_on_end"].as_bool(),
            Some(true)
        );
    }
}

// ---------------------------------------------------------------------------
// Remote catalog fetch
// ---------------------------------------------------------------------------

/// Pin `[features] remote_fetch = false` unless the user set it explicitly.
///
/// EchoAgent is BYOK-only: every usable model comes from the local
/// `[model_providers.*]` / `[model.*]` tables. The embedded Runtime, left alone,
/// defaults this flag on and its model-catalog watcher then fetches an upstream
/// `/v1/models` catalog and merges those entries into the effective catalog.
/// That path bypasses the `has_custom_endpoint()` isolation in `agent_runtime`
/// (which only suppresses the *bundled* defaults), so upstream-branded model ids
/// would reach the picker, the About dialog and the usage table — and it spends a
/// network round trip that a BYOK setup has no use for.
///
/// Must be persisted rather than set in memory: the Runtime resolves this flag by
/// re-reading the config layers (`resolve_remote_fetch_enabled`), and deliberately
/// ignores both the env overlay and the in-memory `AgentConfig`, so the user layer
/// on disk is the only place a host override can land.
///
/// Returns true when a write happened. An explicit user value of either polarity
/// is left untouched, and the key is outside the `model_config_revision` digest
/// (`["model", "models", "model_providers"]`), so writing it cannot disturb the
/// runtime-readiness gate.
pub(crate) fn ensure_remote_fetch_disabled() -> Result<bool, String> {
    let mut config = crate::providers::read_config();
    let already_set = config
        .get("features")
        .and_then(Value::as_table)
        .and_then(|features| features.get("remote_fetch"))
        .and_then(Value::as_bool)
        .is_some();
    if already_set {
        return Ok(false);
    }
    set_nested_bool(&mut config, "features", None, "remote_fetch", false)?;
    crate::providers::write_config(&config)?;
    Ok(true)
}
