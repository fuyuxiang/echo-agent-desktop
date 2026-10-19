//! The conversation tool's wire contract, independent of team persistence.
//! Keep one canonical array schema while accepting unambiguous encodings from
//! model providers. All expert identity and permission checks still run later.

use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

pub(super) const INPUT_EXAMPLE: &str =
    r#"{"team_id":"review-team","members":[{"name":"现有专家的完整名称","role":"分析需求"}]}"#;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateTeamInput {
    #[schemars(description = "Unique team identifier (e.g. 'trading-team')")]
    pub team_id: String,
    #[serde(deserialize_with = "deserialize_members")]
    #[schemars(
        with = "Vec<CreateTeamMember>",
        description = "JSON array of members, e.g. [{\"name\":\"existing-expert-name\",\"role\":\"review\"}]. Each name must exactly match an existing local expert. Do not pass a schema object or a name-to-role dictionary."
    )]
    pub members: Vec<CreateTeamMember>,
    #[schemars(description = "Optional team description")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateTeamMember {
    #[schemars(
        description = "Exact case-sensitive name of an existing local expert (the name in its agent definition)"
    )]
    pub name: String,
    #[schemars(description = "Member role, e.g. 'code reviewer'")]
    pub role: String,
}

fn deserialize_members<'de, D>(deserializer: D) -> Result<Vec<CreateTeamMember>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    // Decode at most once. Do not recursively unwrap arbitrary objects or
    // flatten nested arrays: that could silently change the requested roster.
    let value = match value {
        Value::String(text) => serde_json::from_str::<Value>(&text).map_err(|_| {
            serde::de::Error::custom("members: 必须是成员数组，收到的字符串不是有效的 JSON")
        })?,
        other => other,
    };
    let members = match value {
        Value::Array(members) => members,
        Value::Object(member) if member.contains_key("name") => vec![Value::Object(member)],
        _ => {
            return Err(serde::de::Error::custom(
                "members: 必须是 [{\"name\":\"专家名称\",\"role\":\"分工\"}] 成员数组，不能是 Schema 或名称映射",
            ));
        }
    };
    members
        .into_iter()
        .enumerate()
        .map(|(index, member)| {
            if !member.is_object() {
                return Err(serde::de::Error::custom(format!(
                    "members[{index}]: 必须是包含 name 和 role 的对象"
                )));
            }
            serde_json::from_value(member)
                .map_err(|error| serde::de::Error::custom(format!("members[{index}]: {error}")))
        })
        .collect()
}

pub(super) fn input_schema() -> Value {
    // Match the Runtime's built-in tools: inline member fields so discovery
    // and providers do not have to resolve an items.$ref in a separate $defs.
    let settings = schemars::generate::SchemaSettings::draft07().with(|settings| {
        settings.inline_subschemas = true;
    });
    serde_json::to_value(
        settings
            .into_generator()
            .into_root_schema_for::<CreateTeamInput>(),
    )
    .expect("create_team input schema is serializable")
}

pub(super) fn parse_input(args: &Value) -> Result<CreateTeamInput, String> {
    serde_json::from_value(args.clone()).map_err(|error| {
        format!(
            "create_team 参数无效：{error}。完整参数示例：{INPUT_EXAMPLE}。请使用真实本地专家名称，修正参数后再调用；不要重复提交相同的失败参数。本次未创建团队，也未派发专家任务。"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn schema_inlines_the_canonical_member_array() {
        let schema = input_schema();
        let members = &schema["properties"]["members"];
        assert_eq!(members["type"], "array");
        assert_eq!(members["items"]["type"], "object");
        assert_eq!(members["items"]["properties"]["name"]["type"], "string");
        assert_eq!(members["items"]["properties"]["role"]["type"], "string");
        assert_eq!(members["items"]["additionalProperties"], false);
        assert!(members["items"]["required"]
            .as_array()
            .unwrap()
            .contains(&json!("role")));
        assert!(!schema.to_string().contains("\"$ref\""));
        assert!(!schema.to_string().contains("\"$defs\""));
    }

    #[test]
    fn canonical_array_preserves_the_roster_and_roles() {
        let args = json!({"team_id":"discuss","members":[
            {"name":"代码专家","role":"检查实现"},
            {"name":"业务分析师","role":"分析需求"}
        ],"description":"讨论"});
        let input = parse_input(&args).unwrap();
        assert_eq!(serde_json::to_value(input).unwrap(), args);
    }

    #[test]
    fn accepts_only_unambiguous_provider_encodings() {
        let member = json!({"name":"代码专家","role":"检查实现"});
        for members in [
            member.clone(),
            json!([member.clone()]).to_string().into(),
            member.to_string().into(),
        ] {
            let input = parse_input(&json!({"team_id":"discuss","members":members})).unwrap();
            assert_eq!(input.members.len(), 1);
            assert_eq!(input.members[0].name, "代码专家");
            assert_eq!(input.members[0].role, "检查实现");
            assert_eq!(
                serde_json::to_value(input).unwrap()["members"],
                json!([member])
            );
        }
    }

    #[test]
    fn invalid_shapes_return_a_complete_example_without_guessing_members() {
        for members in [
            json!({"代码专家":"检查实现"}),
            json!({"type":"array","items":[]}),
            json!([[{"name":"代码专家","role":"检查实现"}]]),
            json!(["代码专家"]),
            json!(null),
            json!("not json"),
        ] {
            let error = parse_input(&json!({"team_id":"discuss","members":members})).unwrap_err();
            assert!(error.contains("members"), "{error}");
            assert!(error.contains(INPUT_EXAMPLE), "{error}");
            assert!(error.contains("未创建团队"), "{error}");
        }
    }

    #[test]
    fn errors_identify_the_member_and_missing_or_unknown_field() {
        for (member, field) in [
            (json!({"name":"代码专家"}), "role"),
            (
                json!({"name":"代码专家","role":"检查","extra":true}),
                "extra",
            ),
        ] {
            let error = parse_input(&json!({"team_id":"discuss","members":[member]})).unwrap_err();
            assert!(error.contains("members[0]"), "{error}");
            assert!(error.contains(field), "{error}");
        }
        assert!(parse_input(&json!({"team_id":"discuss","members":[],"unexpected":true})).is_err());
    }

    #[test]
    fn recovery_example_is_itself_a_valid_input() {
        let input = parse_input(&serde_json::from_str(INPUT_EXAMPLE).unwrap()).unwrap();
        assert_eq!(input.members.len(), 1);
    }
}
