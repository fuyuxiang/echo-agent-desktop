//! Skills panel — drives EchoAgent's `echo.agent/skills/*` extension methods.
//!
//! EchoAgent discovers skills by recursively scanning `~/.echo-agent/skills/`,
//! `<cwd>/.echo-agent/skills/`, and a few bundled/plugin dirs (see
//! `xai-grok-tools/src/implementations/skills/discovery.rs`). Each skill is a
//! directory containing a `SKILL.md` with YAML frontmatter. EchoAgent exposes the
//! full CRUD surface over ACP — we call those methods here rather than reading
//! the filesystem ourselves, because EchoAgent holds the canonical enabled/disabled
//! state in `~/.echo-agent/config.toml` (`[skills] disabled`, `[skills] paths`) and
//! reloads on file changes.

use agent_client_protocol as acp;
use serde::Deserialize;
use serde_json::value::RawValue;
use std::sync::Arc;
use tauri::State;

use crate::commands::AppState;
use crate::ext::{call_ext, call_ext_value, raw_params};

/// One discovered skill. Mirrors the relevant fields of EchoAgent's `SkillInfo`
/// (`xai-grok-tools/src/implementations/skills/types.rs:40`). Unknown/missing
/// fields fall back to defaults — the shape is stable across EchoAgent versions but
/// we stay defensive.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    // Runtime SkillInfo itself uses snake_case even though the extension
    // response wrapper uses camelCase. Accept both wire generations.
    #[serde(default, alias = "display_name")]
    pub display_name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// Where the skill was discovered: "local" | "repo" | "user" | "server"
    /// | "bundled" | "plugin". See `SkillScope`.
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default, alias = "user_invocable")]
    pub user_invocable: Option<bool>,
    /// Filesystem path to the skill directory (when available).
    #[serde(default)]
    pub path: Option<String>,
    /// True for packages copied into and owned by EchoAgent's local installer.
    #[serde(default)]
    pub managed: bool,
    /// Installed package version when declared by its install manifest.
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub compatibility: Option<String>,
    #[serde(default, alias = "when_to_use")]
    pub when_to_use: Option<String>,
    /// The exact `[skills].paths` entry that owns this skill, when any.
    /// Removing a discovered SKILL.md path directly would not remove its parent
    /// registration, so the UI must use this field.
    #[serde(default)]
    pub configured_path: Option<String>,
}

/// Generic list shape returned by `echo.agent/skills/list` and `echo.agent/skills/config`:
/// EchoAgent returns either a bare array or `{ skills: [...] }`. We accept both.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum SkillsListResponse {
    Array(Vec<SkillInfo>),
    Wrapped {
        skills: Vec<SkillInfo>,
        #[serde(default)]
        paths: Vec<String>,
    },
}

impl SkillsListResponse {
    fn into_parts(self) -> (Vec<SkillInfo>, Vec<String>) {
        match self {
            SkillsListResponse::Array(v) => (v, Vec::new()),
            SkillsListResponse::Wrapped { skills, paths } => (skills, paths),
        }
    }
}

/// List all skills EchoAgent has discovered. `cwd` is optional (used by EchoAgent to
/// resolve project-scoped skills).
#[tauri::command]
pub async fn skills_list(
    state: State<'_, AppState>,
    cwd: Option<String>,
) -> Result<Vec<SkillInfo>, String> {
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    skills_list_with_tx(&tx, cwd).await
}

/// Internal form used by automations for execution-time capability checks.
pub async fn skills_list_with_tx(
    tx: &xai_acp_lib::AcpAgentTx,
    cwd: Option<String>,
) -> Result<Vec<SkillInfo>, String> {
    // EchoAgent's `echo.agent/skills/list` schema requires `cwd` to be a *string* when
    // present (it rejects `null` with -32602). Omit the key entirely when the
    // caller has no cwd so EchoAgent falls back to its own default.
    let mut params_obj = serde_json::Map::new();
    if let Some(c) = &cwd {
        params_obj.insert("cwd".into(), serde_json::Value::String(c.clone()));
    }
    let params: Arc<RawValue> = raw_params(&serde_json::Value::Object(params_obj));
    // Prefer `echo.agent/skills/config` (richer: includes paths/ignore config), but
    // fall back to `echo.agent/skills/list` if the method is unavailable on this
    // EchoAgent build.
    let res: Result<SkillsListResponse, _> =
        call_ext(tx, "echo.agent/skills/config", params.clone()).await;
    let (skills, configured_paths) = match res {
        Ok(v) => v.into_parts(),
        Err(_) => {
            let v: SkillsListResponse = call_ext(tx, "echo.agent/skills/list", params)
                .await
                .map_err(|e| e.to_string())?;
            v.into_parts()
        }
    };
    Ok(skills
        .into_iter()
        .map(|mut skill| {
            if let Some(path) = skill.path.clone() {
                skill.managed = crate::skill_installer::is_managed_skill(&path);
                if skill.managed {
                    skill.version = crate::skill_installer::managed_skill_version(&path);
                    skill.path = crate::skill_installer::managed_skill_directory(&path);
                } else {
                    skill.configured_path = configured_paths
                        .iter()
                        .filter(|configured| path.starts_with(configured.as_str()))
                        .max_by_key(|configured| configured.len())
                        .cloned();
                }
            }
            skill
        })
        .collect())
}

/// Add a skill path (directory or file) to `[skills].paths` and rescan.
#[tauri::command]
pub async fn skills_add(
    state: State<'_, AppState>,
    path: String,
    cwd: Option<String>,
) -> Result<(), String> {
    crate::policy::require_feature("skills")?;
    crate::policy::require_skill_upload()?;
    crate::skill_installer::validate_registered_source(&path)?;
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    let params = raw_params(&serde_json::json!({ "path": path, "cwd": cwd }));
    let _: acp::ExtResponse = call_ext_value(&tx, "echo.agent/skills/add", params)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Remove a skill path from `[skills].paths`.
#[tauri::command]
pub async fn skills_remove(
    state: State<'_, AppState>,
    path: String,
    cwd: Option<String>,
) -> Result<(), String> {
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    let params = raw_params(&serde_json::json!({ "path": path, "cwd": cwd }));
    let _: acp::ExtResponse = call_ext_value(&tx, "echo.agent/skills/remove", params)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Enable or disable a skill by name (writes `[skills] disabled`).
#[tauri::command]
pub async fn skills_toggle(
    state: State<'_, AppState>,
    name: String,
    enabled: bool,
) -> Result<(), String> {
    let tx = state
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("agent not initialized")?;
    let params = raw_params(&serde_json::json!({ "name": name, "enabled": enabled }));
    let _: acp::ExtResponse = call_ext_value(&tx, "echo.agent/skills/toggle", params)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_snake_case_skill_metadata_is_preserved() {
        let response: SkillsListResponse = serde_json::from_value(serde_json::json!({
            "paths": ["/tmp/skills"],
            "skills": [{
                "name": "deploy",
                "display_name": "Deploy Service",
                "description": "Deploy safely",
                "scope": "user",
                "enabled": true,
                "user_invocable": false,
                "path": "/tmp/skills/deploy/SKILL.md",
                "author": "team",
                "license": "Apache-2.0",
                "compatibility": "Requires git",
                "when_to_use": "release requests"
            }]
        }))
        .unwrap();
        let (skills, paths) = response.into_parts();
        assert_eq!(paths, vec!["/tmp/skills"]);
        assert_eq!(skills[0].display_name.as_deref(), Some("Deploy Service"));
        assert_eq!(skills[0].user_invocable, Some(false));
        assert_eq!(skills[0].when_to_use.as_deref(), Some("release requests"));
    }
}
