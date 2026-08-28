//! Authoritative local policy store and backend enforcement gates.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

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
        "model-whitelist" | "disabled-features" | "sandbox-rules" => {
            if !rule.value.is_array() {
                return Err(format!("{} must be an array", rule.rule_type));
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
        "max-tokens-per-day" => {
            if rule.value.as_u64().filter(|v| *v > 0).is_none() {
                return Err("max-tokens-per-day must be a positive integer".into());
            }
        }
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
    let Ok(raw) = std::fs::read_to_string(policy_path()) else {
        return PolicySet::default();
    };
    let mut set: PolicySet = serde_json::from_str(&raw).unwrap_or_default();
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
    if models.is_empty() || models.iter().any(|v| v.as_str() == Some(model_id)) {
        Ok(())
    } else {
        Err(format!("策略禁止使用模型 {model_id}"))
    }
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
    write_policy(policy)
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
    }
}
