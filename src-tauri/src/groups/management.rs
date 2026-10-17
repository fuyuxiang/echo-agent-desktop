use super::*;
use serde::{Deserialize, Serialize};

#[tauri::command]
pub fn group_member_change(
    app: tauri::AppHandle,
    state: State<'_, crate::commands::AppState>,
    group_id: String,
    action: String,
    member_id: Option<String>,
    expert: Option<String>,
) -> Result<(), String> {
    let snapshot = db()?.get(&group_id)?;
    if snapshot.works.iter().any(|w| !w.terminal()) {
        return Err("请完成或停止当前工作后调整成员".into());
    }
    let definition = if matches!(action.as_str(), "add" | "refresh") {
        let expert = expert
            .or_else(|| {
                snapshot
                    .members
                    .iter()
                    .find(|m| Some(&m.id) == member_id.as_ref())
                    .and_then(|m| m.expert.clone())
            })
            .ok_or("请选择本地专家")?;
        let entry = crate::agents_store::team_agents()
            .into_iter()
            .find(|m| m.name == expert)
            .ok_or("本地专家已不存在，请先恢复专家配置")?;
        let mut parsed =
            echo_agent_core::AgentDefinition::parse(&entry.raw).map_err(|e| e.to_string())?;
        let model = match &parsed.model {
            echo_agent_core::config::ModelOverride::Override(m) => m.clone(),
            _ => snapshot
                .members
                .iter()
                .find(|m| Some(&m.id) == member_id.as_ref())
                .map(|m| m.model_id.clone())
                .unwrap_or_else(|| snapshot.members[0].model_id.clone()),
        };
        crate::commands::require_runtime_ready(Some(&app), &state, Some(&model))?;
        crate::policy::require_model(&model)?;
        parsed.permission_mode = Default::default();
        parsed.memory = None;
        parsed.model = Default::default();
        let mut profile = serde_json::to_value(&parsed).map_err(|e| e.to_string())?;
        profile["promptBody"] = json!(parsed.prompt_body.unwrap_or_default());
        Some((entry, profile, model))
    } else {
        None
    };
    db()?.update(&group_id, |g| {
        if g.works.iter().any(|w| !w.terminal()) {
            return Err("成员正在工作，请稍后调整".into());
        }
        match action.as_str() {
            "add" => {
                let (entry, profile, model) = definition.ok_or("专家配置缺失")?;
                if g.members
                    .iter()
                    .any(|m| !m.removed && m.expert.as_deref() == Some(&entry.name))
                {
                    return Err("专家已在本群中".into());
                }
                if g.members
                    .iter()
                    .filter(|m| !m.removed && m.expert.is_some())
                    .count()
                    >= 8
                {
                    return Err("每个群最多包含 8 名专家".into());
                }
                g.members.push(Member {
                    id: id(),
                    name: entry.name.clone(),
                    expert: Some(entry.name),
                    role: entry.description.unwrap_or_default(),
                    profile,
                    model_id: model,
                    session_id: None,
                    discussion_session_id: None,
                    seen_seq: 0,
                    discussion_seen_seq: 0,
                    generation: 0,
                    removed: false,
                });
            }
            "remove" => {
                let member = g
                    .members
                    .iter_mut()
                    .find(|m| Some(&m.id) == member_id.as_ref() && !m.removed)
                    .ok_or("成员不存在")?;
                if member.id == g.coordinator_id {
                    return Err("请先在群设置中选择其他协调员，再移除此成员".into());
                }
                member.removed = true;
            }
            "refresh" => {
                let (_, profile, model) = definition.ok_or("专家配置缺失")?;
                let member = g
                    .members
                    .iter_mut()
                    .find(|m| Some(&m.id) == member_id.as_ref() && !m.removed)
                    .ok_or("成员不存在")?;
                member.profile = profile;
                member.model_id = model;
                member.session_id = None;
                member.discussion_session_id = None;
                member.seen_seq = 0;
                member.discussion_seen_seq = 0;
                member.generation += 1;
            }
            _ => return Err("不支持的成员操作".into()),
        }
        Ok(())
    })?;
    changed(&group_id);
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamTemplate {
    pub id: String,
    pub name: String,
    pub description: String,
    pub members: Vec<TemplateMember>,
    pub source: String,
    #[serde(default)]
    pub coordinator_name: Option<String>,
    #[serde(default)]
    pub coordinator_role: Option<String>,
    #[serde(default)]
    pub default_model_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateMember {
    pub name: String,
    pub role: String,
    pub model_id: Option<String>,
}

#[tauri::command]
pub fn group_team_templates() -> Result<Vec<TeamTemplate>, String> {
    let mut result = db()?.templates()?;
    for team in crate::team_mcp::team_catalog()? {
        result.push(TeamTemplate {
            id: format!(
                "session:{}:{}",
                team.session_id.as_deref().unwrap_or("legacy"),
                team.team_id
            ),
            name: team.team_id,
            description: team.description.unwrap_or_default(),
            members: team
                .members
                .into_iter()
                .map(|member| TemplateMember {
                    role: team.roles.get(&member.name).cloned().unwrap_or_default(),
                    name: member.name,
                    model_id: None,
                })
                .collect(),
            source: "会话团队".into(),
            coordinator_name: None,
            coordinator_role: None,
            default_model_id: None,
        });
    }
    Ok(result)
}
#[tauri::command]
pub fn group_team_save(group_id: String, name: String) -> Result<TeamTemplate, String> {
    let g = db()?.get(&group_id)?;
    let coordinator = g
        .members
        .iter()
        .find(|m| m.id == g.coordinator_id)
        .ok_or("协调员配置缺失")?
        .clone();
    let mut template = TeamTemplate {
        id: id(),
        name: text(&name, 80, "团队名称")?,
        description: g.goal,
        members: g
            .members
            .into_iter()
            .filter(|m| !m.removed && m.expert.is_some())
            .map(|m| TemplateMember {
                name: m.expert.unwrap(),
                role: m.role,
                model_id: Some(m.model_id),
            })
            .collect(),
        source: "常用团队".into(),
        coordinator_name: coordinator.expert,
        coordinator_role: Some(coordinator.role),
        default_model_id: Some(coordinator.model_id),
    };
    if let Some(previous) = db()?
        .templates()?
        .into_iter()
        .find(|t| t.name == template.name)
    {
        template.id = previous.id;
    }
    db()?.save_template(&template)?;
    Ok(template)
}
#[tauri::command]
pub fn group_team_delete(template_id: String) -> Result<(), String> {
    db()?.delete_template(&template_id)
}

#[tauri::command]
pub fn group_decision(
    group_id: String,
    text: String,
    message_id: String,
    decision_id: Option<String>,
) -> Result<(), String> {
    db()?.update(&group_id, |g| {
        if let Some(id) = decision_id {
            let decision = g
                .decisions
                .iter_mut()
                .find(|d| d.id == id)
                .ok_or("决定记录不存在")?;
            decision.confirmed = true;
            return Ok(());
        }
        if !g.messages.iter().any(|m| m.id == message_id) {
            return Err("来源消息不存在".into());
        }
        if g.decisions.len() >= 100 {
            return Err("决定记录已达上限".into());
        }
        g.decisions.push(Decision {
            id: id(),
            text: super::text(&text, 2000, "决定")?,
            message_id: Some(message_id),
            created_at: now(),
            confirmed: true,
        });
        Ok(())
    })?;
    changed(&group_id);
    Ok(())
}
