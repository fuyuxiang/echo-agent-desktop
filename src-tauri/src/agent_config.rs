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
