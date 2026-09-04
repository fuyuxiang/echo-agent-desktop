//! Authoritative local policy store and backend enforcement gates.

use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAX_POLICY_BYTES: u64 = 1024 * 1024;
const MAX_POLICY_ARRAY_ITEMS: usize = 512;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyRule {
    #[serde(rename = "type")]
    pub rule_type: String,
    pub value: Value,
    #[serde(default)]
    pub priority: i64,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PolicySet {
    #[serde(default)]
    pub rules: Vec<PolicyRule>,
}

fn policy_path() -> PathBuf {
    crate::paths::echo_agent_home_dir().join("echoagent-policy.json")
}

fn validate_rule(rule: &PolicyRule) -> Result<(), String> {
    match rule.rule_type.as_str() {
        "model-whitelist" | "disabled-features" => {
            let Some(values) = rule.value.as_array() else {
                return Err(format!("{} must be an array", rule.rule_type));
            };
            if values.len() > MAX_POLICY_ARRAY_ITEMS
                || values.iter().any(|value| {
                    value.as_str().is_none_or(|item| {
                        item.is_empty() || item.len() > 512 || item.chars().any(char::is_control)
                    })
                })
            {
                return Err(format!(
                    "{} must contain at most {MAX_POLICY_ARRAY_ITEMS} non-empty strings",
                    rule.rule_type
                ));
            }
        }
        "skill-upload" => {
            if !rule.value.is_boolean() {
                return Err("skill-upload must be boolean".into());
            }
        }
        "permission-mode" => {
            let mode = rule.value.as_str().unwrap_or_default();
            if !["ask", "auto", "always-approve"].contains(&mode) {
                return Err("permission-mode must be ask, auto or always-approve".into());
            }
        }
        "sandbox-rules" | "max-tokens-per-day" => return Err(format!(
            "policy type '{}' is not supported by this build and was not saved; enforcing it only in the UI would create a false security boundary",
            rule.rule_type
        )),
        other => return Err(format!("unknown policy type: {other}")),
    }
    Ok(())
}

fn merge_rules(rules: Vec<PolicyRule>) -> Vec<PolicyRule> {
    let mut merged: HashMap<String, (usize, PolicyRule)> = HashMap::new();
    for (index, rule) in rules.into_iter().enumerate() {
        let replace = merged
            .get(&rule.rule_type)
            .map(|(old_index, old)| {
                rule.priority > old.priority
                    || (rule.priority == old.priority && index >= *old_index)
            })
            .unwrap_or(true);
        if replace {
            merged.insert(rule.rule_type.clone(), (index, rule));
        }
    }
    let mut values: Vec<_> = merged.into_values().collect();
    values.sort_by_key(|(index, _)| *index);
    values.into_iter().map(|(_, rule)| rule).collect()
}

pub fn read_policy() -> PolicySet {
    let path = policy_path();
    let Ok(file) = std::fs::File::open(&path) else {
        return PolicySet::default();
    };
    let mut raw = Vec::new();
    if file
        .take(MAX_POLICY_BYTES.saturating_add(1))
        .read_to_end(&mut raw)
        .is_err()
        || raw.len() as u64 > MAX_POLICY_BYTES
    {
        tracing::warn!(path = %path.display(), "local policy file is unreadable or exceeds 1MB; no local policy was loaded");
        return PolicySet::default();
    }
    let mut set: PolicySet = match serde_json::from_slice(&raw) {
        Ok(set) => set,
        Err(error) => {
            tracing::warn!(%error, "local policy file is invalid; no local policy was loaded");
            return PolicySet::default();
        }
    };
    // Legacy builds accepted policy kinds they never enforced. Never expose
    // those entries as active policy after an upgrade.
    set.rules.retain(|rule| {
        let result = validate_rule(rule);
        if let Err(error) = &result {
            tracing::warn!(rule_type = %rule.rule_type, %error, "ignored unsupported local policy rule");
        }
        result.is_ok()
    });
    set.rules = merge_rules(set.rules);
    set
}

fn write_policy(mut set: PolicySet) -> Result<PolicySet, String> {
    for rule in &set.rules {
        validate_rule(rule)?;
    }
    set.rules = merge_rules(set.rules);
    let raw = serde_json::to_vec_pretty(&set).map_err(|e| format!("serialize policy: {e}"))?;
    crate::paths::write_private_file(&policy_path(), &raw)?;
    Ok(set)
}

fn value(rule_type: &str) -> Option<Value> {
    read_policy()
        .rules
        .into_iter()
        .find(|rule| rule.rule_type == rule_type)
        .map(|rule| rule.value)
}

pub fn require_model(model_id: &str) -> Result<(), String> {
    let Some(models) = value("model-whitelist").and_then(|v| v.as_array().cloned()) else {
        return Ok(());
    };
    if model_allowed(&models, model_id) {
        Ok(())
    } else {
        Err(format!("策略禁止使用模型 {model_id}"))
    }
}

fn model_allowed(models: &[Value], model_id: &str) -> bool {
    models.iter().any(|value| value.as_str() == Some(model_id))
}

pub fn require_skill_upload() -> Result<(), String> {
    if value("skill-upload").and_then(|v| v.as_bool()) == Some(false) {
        Err("策略禁止安装或上传技能".into())
    } else {
        Ok(())
    }
}

pub fn require_feature(feature: &str) -> Result<(), String> {
    let disabled = value("disabled-features")
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    if disabled.iter().any(|v| v.as_str() == Some(feature)) {
        Err(format!("策略已禁用功能 {feature}"))
    } else {
        Ok(())
    }
}

pub fn locked_permission_mode() -> Option<String> {
    value("permission-mode")
        .and_then(|v| v.as_str().map(str::to_string))
        .filter(|m| ["ask", "auto", "always-approve"].contains(&m.as_str()))
}

#[tauri::command]
pub fn policy_get() -> PolicySet {
    read_policy()
}

#[tauri::command]
pub fn policy_save(policy: PolicySet) -> Result<PolicySet, String> {
    write_policy(normalize_local_policy(policy))
}

fn normalize_local_policy(mut policy: PolicySet) -> PolicySet {
    // IPC callers do not get to self-assign an administrator-like source or
    // priority. Managed organization policy has its own signed channel.
    for rule in &mut policy.rules {
        rule.priority = 0;
        rule.source = Some("local-user".into());
    }
    policy
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_uses_priority_then_last_value() {
        let rules = vec![
            PolicyRule {
                rule_type: "skill-upload".into(),
                value: Value::Bool(true),
                priority: 0,
                source: None,
            },
            PolicyRule {
                rule_type: "skill-upload".into(),
                value: Value::Bool(false),
                priority: 2,
                source: None,
            },
            PolicyRule {
                rule_type: "skill-upload".into(),
                value: Value::Bool(true),
                priority: 1,
                source: None,
            },
        ];
        let merged = merge_rules(rules);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].value, Value::Bool(false));
    }

    #[test]
    fn validation_rejects_unknown_and_invalid_values() {
        let invalid = PolicyRule {
            rule_type: "permission-mode".into(),
            value: Value::String("root".into()),
            priority: 0,
            source: None,
        };
        assert!(validate_rule(&invalid).is_err());
        let unknown = PolicyRule {
            rule_type: "mystery".into(),
            value: Value::Null,
            priority: 0,
            source: None,
        };
        assert!(validate_rule(&unknown).is_err());

        for unsupported in ["sandbox-rules", "max-tokens-per-day"] {
            let rule = PolicyRule {
                rule_type: unsupported.into(),
                value: Value::Array(Vec::new()),
                priority: 0,
                source: None,
            };
            assert!(validate_rule(&rule).unwrap_err().contains("not supported"));
        }
    }

    #[test]
    fn renderer_metadata_is_replaced_with_local_provenance() {
        let policy = normalize_local_policy(PolicySet {
            rules: vec![PolicyRule {
                rule_type: "skill-upload".into(),
                value: Value::Bool(true),
                priority: i64::MAX,
                source: Some("administrator".into()),
            }],
        });
        assert_eq!(policy.rules[0].priority, 0);
        assert_eq!(policy.rules[0].source.as_deref(), Some("local-user"));
    }

    #[test]
    fn explicit_empty_model_whitelist_denies_every_model() {
        assert!(!model_allowed(&[], "model-a"));
    }
}
