//! Persistent multi-expert conversations, executed exclusively by Agent Runtime.
pub(crate) mod management;
mod mcp;
mod model;
#[cfg(test)]
mod native_smoke;
mod runtime;
mod store;
#[cfg(test)]
mod tests;
pub use model::*;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock, RwLock};
use store::Store;
use tauri::{Emitter, Manager, State};

static STORE: OnceLock<Store> = OnceLock::new();
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
type Owner = (String, String);
static OWNERS: OnceLock<RwLock<std::collections::HashMap<String, Option<Owner>>>> = OnceLock::new();
static INIT_ERROR: OnceLock<Mutex<Option<String>>> = OnceLock::new();
pub fn initialize(app: tauri::AppHandle) -> Result<(), String> {
    let store = Store::open(&crate::paths::echo_agent_home_dir().join("collaboration.sqlite"))
        .inspect_err(|error| {
            *INIT_ERROR.get_or_init(Default::default).lock().unwrap() = Some(error.clone());
        })?;
    store.recover().inspect_err(|error| {
        *INIT_ERROR.get_or_init(Default::default).lock().unwrap() =
            Some(format!("专家团记录恢复失败，已有数据已保留：{error}"));
    })?;
    STORE.set(store).map_err(|_| "专家团服务已初始化")?;
    APP.set(app).map_err(|_| "专家团事件已初始化")?;
    Ok(())
}
fn db() -> Result<&'static Store, String> {
    STORE.get().ok_or_else(|| {
        INIT_ERROR
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| "专家团服务尚未就绪".into())
    })
}
fn changed(group_id: &str) {
    if let Some(app) = APP.get() {
        let _ = app.emit("group://changed", json!({"groupId":group_id}));
    }
}
pub fn is_member_session(session: &str) -> bool {
    session_owner(session).is_some()
}
fn session_owner(session: &str) -> Option<Owner> {
    let cache = OWNERS.get_or_init(Default::default);
    if let Some(owner) = cache.read().unwrap().get(session) {
        return owner.clone();
    }
    let owner = db().and_then(|s| s.owner(session)).ok()?;
    let mut cache = cache.write().unwrap();
    if cache.len() > 20000 {
        cache.clear();
    }
    cache.insert(session.into(), owner.clone());
    owner
}
fn remember_owner(session: &str, group: &str, member: &str) {
    OWNERS
        .get_or_init(Default::default)
        .write()
        .unwrap()
        .insert(session.into(), Some((group.into(), member.into())));
}
pub fn has_member(group: &str, member: &str) -> bool {
    db().and_then(|s| s.get(group))
        .is_ok_and(|g| g.members.iter().any(|m| m.id == member && !m.removed))
}
pub fn mcp_tools() -> Value {
    mcp::tools()
}
pub fn mcp_call(session: &str, params: &Value) -> Result<Value, String> {
    mcp::call(session, params)
}

fn text(value: &str, limit: usize, label: &str) -> Result<String, String> {
    let s = value.trim();
    if s.is_empty() || s.chars().count() > limit || s.contains('\0') {
        Err(format!("{label}不能为空且不能超过 {limit} 个字符"))
    } else {
        Ok(s.into())
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateInput {
    pub name: String,
    pub goal: Option<String>,
    pub cwd: String,
    pub model_id: String,
    pub members: Vec<String>,
    pub source_session_id: Option<String>,
    pub source_team_id: Option<String>,
    pub reference_text: Option<String>,
    pub roles: Option<std::collections::HashMap<String, String>>,
    pub models: Option<std::collections::HashMap<String, String>>,
    pub coordinator_name: Option<String>,
    pub coordinator_role: Option<String>,
}

#[tauri::command]
pub fn group_create(
    app: tauri::AppHandle,
    state: State<'_, crate::commands::AppState>,
    input: CreateInput,
) -> Result<Group, String> {
    crate::policy::require_feature("sessions")?;
    crate::commands::require_runtime_ready(Some(&app), &state, Some(&input.model_id))?;
    crate::policy::require_model(&input.model_id)?;
    let cwd = app
        .state::<crate::shell_fs::FilesystemAccess>()
        .require_workspace(&input.cwd)?
        .to_string_lossy()
        .to_string();
    let source = input
        .source_session_id
        .as_deref()
        .map(|sid| state.session_workspace(sid))
        .transpose()?;
    if source
        .as_ref()
        .is_some_and(|root| root.to_string_lossy() != cwd)
    {
        return Err("专家团工作区与来源会话不一致".into());
    }
    let definitions = crate::agents_store::team_agents();
    let name = text(&input.name, 80, "专家团名称")?;
    let goal = input.goal.unwrap_or_default();
    if goal.chars().count() > 4096 {
        return Err("协作目标不能超过 4096 字".into());
    }
    if input.members.is_empty() || input.members.len() > 8 {
        return Err("请选择 1–8 名本地专家".into());
    }
    let mut names = std::collections::HashSet::new();
    let coordinator = id();
    let profile = json!({"name":"group-coordinator","description":"团队协调员","promptMode":"extend","promptBody":"你是团队协调员。围绕用户目标与群内专家协作。需要专业工作时使用 group_call_member；查看其返回的工作 ID，等待真实结果后汇总。普通问候和简单问题直接回答。不要编造已完成的工作或文件。不要创建额外团队，不要用原生 task 代替群内成员调用。"});
    let mut members = vec![Member {
        id: coordinator.clone(),
        name: "协调员".into(),
        expert: None,
        role: "理解目标、组织协作、检查交付".into(),
        profile,
        model_id: input.model_id.clone(),
        session_id: None,
        discussion_session_id: None,
        seen_seq: 0,
        discussion_seen_seq: 0,
        generation: 0,
        removed: false,
    }];
    let source_team =
        if let (Some(sid), Some(tid)) = (&input.source_session_id, &input.source_team_id) {
            crate::team_mcp::team_snapshot(sid.clone())?
                .into_iter()
                .find(|t| &t.team_id == tid)
        } else {
            None
        };
    for expert in input.members {
        if !names.insert(expert.clone()) {
            return Err("不能重复添加同一专家".into());
        }
        let def = definitions
            .iter()
            .find(|d| d.name == expert)
            .ok_or_else(|| format!("本地专家“{expert}”不存在"))?;
        let mut parsed = echo_agent_core::AgentDefinition::parse(&def.raw)
            .map_err(|e| format!("专家“{expert}”配置无效：{e}"))?;
        let effective_model = input
            .models
            .as_ref()
            .and_then(|models| models.get(&expert))
            .cloned()
            .unwrap_or_else(|| match &parsed.model {
                echo_agent_core::config::ModelOverride::Override(model) => model.clone(),
                _ => input.model_id.clone(),
            });
        crate::commands::require_runtime_ready(Some(&app), &state, Some(&effective_model))?;
        crate::policy::require_model(&effective_model)?;
        parsed.permission_mode = Default::default();
        parsed.memory = None;
        parsed.model = Default::default();
        let prompt = parsed.prompt_body.clone().unwrap_or_default();
        let mut profile = serde_json::to_value(&parsed).map_err(|e| e.to_string())?;
        profile["promptBody"] = json!(prompt);
        let role = input
            .roles
            .as_ref()
            .and_then(|roles| roles.get(&expert))
            .cloned()
            .or_else(|| {
                source_team
                    .as_ref()
                    .and_then(|t| t.roles.get(&expert))
                    .cloned()
            })
            .or_else(|| def.description.clone())
            .unwrap_or_default();
        if role.chars().count() > 1000 {
            return Err("成员职责不能超过 1000 字".into());
        }
        members.push(Member {
            id: id(),
            name: expert.clone(),
            expert: Some(expert),
            role,
            profile,
            model_id: effective_model,
            session_id: None,
            discussion_session_id: None,
            seen_seq: 0,
            discussion_seen_seq: 0,
            generation: 0,
            removed: false,
        });
    }
    let coordinator = if let Some(name) = input.coordinator_name {
        members
            .iter()
            .find(|m| m.expert.as_deref() == Some(&name))
            .map(|m| m.id.clone())
            .ok_or("编组协调员不在所选专家中")?
    } else {
        coordinator
    };
    if let Some(role) = input.coordinator_role {
        if role.chars().count() > 1000 {
            return Err("协调员职责不能超过 1000 字".into());
        }
        members
            .iter_mut()
            .find(|m| m.id == coordinator)
            .unwrap()
            .role = role;
    }
    let mut g = Group {
        id: id(),
        name,
        goal,
        cwd,
        source_session_id: input.source_session_id,
        source_team_id: input.source_team_id,
        coordinator_id: coordinator,
        permission_mode: "ask".into(),
        members,
        messages: vec![],
        works: vec![],
        decisions: vec![],
        archived: false,
        pinned: false,
        paused: false,
        epoch: 0,
        revision: 1,
        created_at: now(),
        updated_at: now(),
        max_calls: 12,
        token_budget: 100_000,
    };
    if let Some(reference) = input.reference_text {
        if reference.chars().count() > 30_000 {
            return Err("引用内容超过 30000 字".into());
        }
        if !reference.trim().is_empty() {
            g.post(None, "reference", reference, None);
        }
    }
    db()?.create(&g)?;
    changed(&g.id);
    Ok(g)
}

#[tauri::command]
pub fn group_list() -> Result<Vec<Group>, String> {
    let mut groups = db()?.list()?;
    // Cards, global search and sidebar routing need metadata, not private
    // expert definitions or the complete decision revision history.
    for group in &mut groups {
        group.decisions.clear();
        for member in &mut group.members {
            member.profile = json!({});
        }
        for message in &mut group.messages {
            message.knowledge = Knowledge::default();
        }
    }
    Ok(groups)
}
#[tauri::command]
pub fn group_snapshot(group_id: String) -> Result<Group, String> {
    db()?.get(&group_id)
}

#[tauri::command]
pub fn group_owner(session_id: String) -> Result<Option<String>, String> {
    Ok(db()?.owner(&session_id)?.map(|(group, _)| group))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SendInput {
    pub id: String,
    pub text: String,
    pub member_ids: Vec<String>,
    pub discussion: bool,
    pub attachments: Vec<String>,
    pub reply_to: Option<String>,
    #[serde(default)]
    pub knowledge: Knowledge,
}

fn send(g: &mut Group, input: &SendInput) -> Result<(), String> {
    if g.messages.iter().any(|m| m.id == input.id) {
        return Ok(());
    }
    if g.messages.len() >= 20_000 || g.works.len() >= 10_000 {
        return Err("专家团历史已达到存储上限，请围绕新目标建立专家团".into());
    }
    if g.paused || g.archived {
        return Err("请先恢复专家团协作".into());
    }
    if input.id.len() > 128 || input.id.is_empty() {
        return Err("消息标识无效".into());
    }
    if input.text.trim().is_empty() && input.attachments.is_empty() {
        return Err("请输入消息或添加附件".into());
    }
    if input.text.chars().count() > 50_000 {
        return Err("消息不能超过 50000 字".into());
    }
    if input.knowledge.context.chars().count() > 20_000
        || (!input.knowledge.personal && !input.knowledge.context.is_empty())
        || (!input.knowledge.organization && !input.knowledge.organization_scope_ids.is_empty())
        || input.knowledge.organization_scope_ids.len() > 64
        || input.knowledge.organization_scope_ids.iter().any(|s| {
            s.trim().is_empty()
                || s.chars().count() > 256
                || s.chars().any(|c| c.is_control() || c == ',')
        })
    {
        return Err("共享知识来源或摘录格式无效".into());
    }
    let mut targets = input.member_ids.clone();
    if targets.is_empty() {
        targets = mentioned_targets(g, &input.text);
    }
    if targets.is_empty() {
        if let Some(reply) = input
            .reply_to
            .as_deref()
            .and_then(|id| g.messages.iter().find(|m| m.id == id))
        {
            if let Some(member) = reply
                .member_id
                .as_ref()
                .filter(|id| g.members.iter().any(|m| &m.id == *id && !m.removed))
            {
                targets.push(member.clone());
            }
        }
        if targets.is_empty() {
            targets.push(g.coordinator_id.clone());
        }
    }
    targets.sort();
    targets.dedup();
    let quoted = input
        .reply_to
        .as_deref()
        .map(|id| {
            g.messages
                .iter()
                .find(|m| m.id == id)
                .map(|m| m.text.clone())
                .ok_or_else(|| "回复的消息不存在".to_string())
        })
        .transpose()?;
    let prompt = if let Some(quoted) = quoted {
        format!("回复引用：\n{quoted}\n\n{}", input.text)
    } else {
        input.text.clone()
    };
    for target in targets {
        g.enqueue(
            &input.id,
            &target,
            prompt.clone(),
            input.discussion,
            None,
            0,
        )?;
    }
    let message = g.post(None, "user", input.text.clone(), None);
    message.id = input.id.clone();
    message.attachments = input.attachments.clone();
    message.reply_to = input.reply_to.clone();
    message.knowledge = input.knowledge.clone();
    Ok(())
}

fn mentioned_targets(group: &Group, body: &str) -> Vec<String> {
    let stripped = regex::Regex::new(r"(?s)```.*?```|`[^`]*`")
        .unwrap()
        .replace_all(body, " ");
    if regex::Regex::new(r"(?i)(?:^|\s)@(?:全体|all)(?:$|[\s，,。；;：:！!？?])")
        .unwrap()
        .is_match(&stripped)
    {
        return group
            .members
            .iter()
            .filter(|m| m.expert.is_some() && !m.removed)
            .map(|m| m.id.clone())
            .collect();
    }
    let mut members = group
        .members
        .iter()
        .filter(|m| !m.removed)
        .collect::<Vec<_>>();
    members.sort_by_key(|m| std::cmp::Reverse(m.name.len()));
    let mut spans = Vec::<(usize, usize)>::new();
    let mut result = vec![];
    for member in members {
        let regex = regex::Regex::new(&format!(
            r"(?:^|\s)@{}(?:$|[\s，,。；;：:！!？?])",
            regex::escape(&member.name)
        ))
        .unwrap();
        for matched in regex.find_iter(&stripped) {
            let start = matched.start() + matched.as_str().find('@').unwrap();
            let end = start + member.name.len() + 1;
            if spans.iter().any(|(a, b)| start < *b && end > *a) {
                continue;
            }
            spans.push((start, end));
            if !result.contains(&member.id) {
                result.push(member.id.clone());
            }
        }
    }
    result
}

#[tauri::command]
pub fn group_send(
    app: tauri::AppHandle,
    state: State<'_, crate::commands::AppState>,
    group_id: String,
    mut input: SendInput,
) -> Result<(), String> {
    crate::commands::require_runtime_ready(Some(&app), &state, None)?;
    let g = db()?.get(&group_id)?;
    let root = app
        .state::<crate::shell_fs::FilesystemAccess>()
        .require_workspace(&g.cwd)?;
    input.attachments = app
        .state::<crate::shell_fs::FilesystemAccess>()
        .validate_session_attachments(&root, &input.attachments)?;
    db()?.update(&group_id, |g| send(g, &input))?;
    changed(&group_id);
    runtime::kick(app, group_id);
    Ok(())
}

#[tauri::command]
pub async fn group_control(
    app: tauri::AppHandle,
    state: State<'_, crate::commands::AppState>,
    group_id: String,
    action: String,
    work_id: Option<String>,
) -> Result<(), String> {
    // A later prompt for the same member must not overtake an acknowledged
    // stop, including when the previous turn completes during cancellation.
    let _dispatch = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        runtime::dispatch_lock(&group_id).lock_owned(),
    )
    .await
    .map_err(|_| "成员仍在准备执行，记录已保留，请稍后重试".to_string())?;
    let mut sessions = vec![];
    db()?.update(&group_id, |g| {
        match action.as_str() {
            "resume" => {
                g.paused = false;
                g.archived = false;
                g.ready_callbacks();
            }
            "pause" => g.paused = true,
            "archive" => {
                if g.works.iter().any(|w| !w.terminal()) {
                    return Err("请先停止或完成当前工作，再归档专家团".into());
                }
                g.archived = true;
            }
            "pin" => g.pinned = !g.pinned,
            "stop" => sessions = g.stop_work(work_id.as_deref())?,
            "retry" => {
                let work = g.works.iter().find(|w| Some(&w.id) == work_id.as_ref())
                    .cloned().ok_or("工作不存在")?;
                if !matches!(work.status.as_str(), "failed" | "uncertain" | "cancelled") {
                    return Err("只能重试失败、停止或执行情况未确认的工作".into());
                }
                if work.status == "uncertain" {
                    sessions.extend(g.stop_work(Some(&work.id))?);
                }
                g.paused = false;
                let root = id();
                let source = g.messages.iter().find(|m| m.id == work.root_id).cloned();
                g.enqueue(&root, &work.member_id,
                    format!("此前工作未完成。请先检查已有文件和执行结果，避免重复产生副作用，再完成：\n{}", work.prompt),
                    work.discussion, None, 0)?;
                let message = g.post(None, "user", format!("检查后继续：{}", work.prompt), None);
                message.id = root;
                if let Some(source) = source {
                    message.attachments = source.attachments;
                    message.knowledge = source.knowledge;
                }
            }
            _ => return Err("不支持的专家团操作".into()),
        }
        g.ready_callbacks();
        Ok(())
    })?;
    changed(&group_id);
    let tx = state.tx.lock().unwrap().clone();
    let mut errors = vec![];
    if let Some(tx) = tx {
        for (sid, prompt) in sessions {
            if let Err(e) = crate::agent_runtime::cancel(&tx, &sid, "stop", Some(&prompt)).await {
                errors.push(e.to_string());
            }
        }
    } else if !sessions.is_empty() {
        errors.push("Agent Runtime 已断开，请重启应用后检查执行记录".into());
    }
    runtime::kick(app, group_id);
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "已停止新派发，但部分工作尚未确认停止，请再次停止或检查执行记录：{}",
            errors.join("；")
        ))
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub session_ids: Vec<String>,
}

#[tauri::command]
pub fn group_cleanup_pending() -> Result<Vec<store::CleanupReceipt>, String> {
    db()?.pending_cleanup()
}

#[tauri::command]
pub fn group_cleanup_ack(group_id: String) -> Result<(), String> {
    db()?.ack_cleanup(&group_id)
}

fn remove_group_memory(home: &std::path::Path, group_id: &str) -> Result<(), String> {
    if group_id.is_empty()
        || group_id.len() > 64
        || !group_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
    {
        return Err("专家团记忆标识无效，记录已保留".into());
    }
    let root = home.join("group-memory");
    for path in [&root, &root.join(group_id)] {
        match std::fs::symlink_metadata(path) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => return Err("专家团记忆目录无效，记录已保留，请检查存储目录后重试".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(format!("读取专家团记忆目录失败，记录已保留：{error}")),
        }
    }
    std::fs::remove_dir_all(root.join(group_id))
        .map_err(|error| format!("专家团记忆清理未完成，记录已保留，可重试删除：{error}"))
}

#[tauri::command]
pub async fn group_delete(
    state: State<'_, crate::commands::AppState>,
    group_id: String,
    stop_work: bool,
) -> Result<DeleteResult, String> {
    delete_group_data(&state, group_id, stop_work).await
}

pub(super) async fn delete_group_data(
    state: &crate::commands::AppState,
    group_id: String,
    stop_work: bool,
) -> Result<DeleteResult, String> {
    let _dispatch = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        runtime::dispatch_lock(&group_id).lock_owned(),
    )
    .await
    .map_err(|_| "成员仍在准备执行，记录已保留，请稍后重试".to_string())?;
    let store = db()?;
    let snapshot = store.get(&group_id)?;
    if !stop_work && snapshot.works.iter().any(|w| !w.terminal()) {
        return Err("专家团正在工作，请确认停止工作后再删除".into());
    }
    let sessions = store.update(&group_id, |g| g.stop_work(None))?;
    changed(&group_id);
    if !sessions.is_empty() {
        let tx = state
            .tx
            .lock()
            .unwrap()
            .clone()
            .ok_or("Agent Runtime 尚未就绪，专家团已暂停，记录已保留，请稍后重试")?;
        for (sid, prompt) in sessions {
            tokio::time::timeout(
                std::time::Duration::from_secs(20),
                crate::agent_runtime::cancel(&tx, &sid, "stop", Some(&prompt)),
            )
            .await
            .map_err(|_| "停止工作超时，记录已保留，请稍后重试".to_string())?
            .map_err(|e| format!("尚未确认工作停止，记录已保留：{e}"))?;
        }
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        while store.get(&group_id)?.works.iter().any(|w| !w.terminal()) {
            if tokio::time::Instant::now() >= deadline {
                return Err("工作仍在停止，专家团及记录已保留，请稍后重试删除".into());
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }
    // Resolve historical workspaces before any native deletion. The ledger
    // survives partial cleanup or a restart so retries clean the same scope.
    let catalog = crate::sessions::list_all_sessions(true)?;
    for sid in store.sessions(&group_id)? {
        let cwd = state
            .session_workspace(&sid)
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
            .or_else(|| {
                catalog
                    .iter()
                    .find(|s| s.session_id == sid)
                    .map(|s| s.cwd.clone())
            })
            .unwrap_or_else(|| snapshot.cwd.clone());
        store.stage_session_delete(&group_id, &sid, &cwd)?;
    }
    let entries = store.deletion_sessions(&group_id)?;
    for (sid, cwd) in &entries {
        // Continuing after a failed attempt must create fresh contexts.
        store.update(&group_id, |g| {
            for member in &mut g.members {
                if member.session_id.as_ref() == Some(sid) {
                    member.session_id = None;
                    member.seen_seq = 0;
                    member.generation += 1;
                }
                if member.discussion_session_id.as_ref() == Some(sid) {
                    member.discussion_session_id = None;
                    member.discussion_seen_seq = 0;
                    member.generation += 1;
                }
            }
            Ok(())
        })?;
        changed(&group_id);
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            crate::commands::delete_group_session_data(state, sid, std::path::Path::new(cwd)),
        )
        .await
        .map_err(|_| "执行记录清理超时，专家团记录已保留，可稍后重试".to_string())?
        .map_err(|e| format!("内部执行记录清理未完成，专家团记录已保留，可重试删除：{e}"))?;
        if !echo_agent_runtime::session::persistence::session_history_paths(sid, None)
            .map_err(|e| e.to_string())?
            .is_empty()
        {
            return Err("内部执行历史尚未清理完成，专家团记录已保留，请重试删除".into());
        }
        if let Some(error) = result.memory_cleanup_warning {
            return Err(format!(
                "内部摘要清理未完成，专家团记录已保留，可重试删除：{error}"
            ));
        }
    }
    remove_group_memory(&crate::paths::echo_agent_home_dir(), &group_id)?;
    store.delete(&group_id)?;
    OWNERS
        .get_or_init(Default::default)
        .write()
        .unwrap()
        .retain(|_, owner| !owner.as_ref().is_some_and(|(group, _)| group == &group_id));
    let session_ids = entries.into_iter().map(|(sid, _)| sid).collect::<Vec<_>>();
    if let Some(app) = APP.get() {
        let _ = app.emit(
            "group://changed",
            json!({"groupId":group_id,"deleted":true,"sessionIds":session_ids}),
        );
    }
    Ok(DeleteResult { session_ids })
}

#[tauri::command]
pub async fn group_metadata(
    group_id: String,
    name: Option<String>,
    pinned: Option<bool>,
    archived: Option<bool>,
) -> Result<(), String> {
    let _dispatch = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        runtime::dispatch_lock(&group_id).lock_owned(),
    )
    .await
    .map_err(|_| "成员仍在准备执行，记录已保留，请稍后重试".to_string())?;
    db()?.update(&group_id, |g| {
        if let Some(name) = name {
            g.name = text(&name, 80, "专家团名称")?;
        }
        if let Some(pinned) = pinned {
            g.pinned = pinned;
        }
        if let Some(archived) = archived {
            if archived && g.works.iter().any(|w| !w.terminal()) {
                return Err("请先停止当前工作，再归档专家团".into());
            }
            g.archived = archived;
        }
        Ok(())
    })?;
    changed(&group_id);
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsInput {
    #[serde(default)]
    pub expected_revision: Option<u64>,
    pub name: String,
    pub goal: String,
    pub coordinator_id: String,
    pub max_calls: usize,
    pub token_budget: u64,
    pub members: Vec<MemberSettings>,
    pub cwd: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemberSettings {
    pub id: String,
    pub role: String,
    pub model_id: String,
}
#[tauri::command]
pub async fn group_settings(
    app: tauri::AppHandle,
    state: State<'_, crate::commands::AppState>,
    group_id: String,
    input: SettingsInput,
) -> Result<(), String> {
    let _dispatch = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        runtime::dispatch_lock(&group_id).lock_owned(),
    )
    .await
    .map_err(|_| "成员仍在准备执行，记录已保留，请稍后重试".to_string())?;
    let cwd = input
        .cwd
        .as_ref()
        .map(|cwd| {
            app.state::<crate::shell_fs::FilesystemAccess>()
                .require_workspace(cwd)
                .map(|p| p.to_string_lossy().to_string())
        })
        .transpose()?;
    for m in &input.members {
        crate::commands::require_runtime_ready(Some(&app), &state, Some(&m.model_id))?;
        crate::policy::require_model(&m.model_id)?;
    }
    db()?.update(&group_id, |g| {
        if input
            .expected_revision
            .is_some_and(|revision| revision != g.revision)
        {
            return Err("专家团设置已更新，请检查最新内容后重试保存".into());
        }
        if g.works.iter().any(|w| !w.terminal()) {
            return Err("请完成或停止当前工作，再修改专家团设置".into());
        }
        g.name = text(&input.name, 80, "专家团名称")?;
        if input.goal.chars().count() > 4096 {
            return Err("协作目标过长".into());
        }
        g.goal = input.goal;
        if let Some(cwd) = cwd {
            if cwd != g.cwd {
                g.cwd = cwd;
                for member in &mut g.members {
                    member.session_id = None;
                    member.discussion_session_id = None;
                    member.seen_seq = 0;
                    member.discussion_seen_seq = 0;
                    member.generation += 1;
                }
                g.post(
                    None,
                    "reference",
                    "工作区已更换。成员将在新工作区继续，已有记录已保留。".into(),
                    None,
                );
            }
        }
        if !g
            .members
            .iter()
            .any(|m| m.id == input.coordinator_id && !m.removed)
        {
            return Err("协调员必须是专家团成员".into());
        }
        g.coordinator_id = input.coordinator_id;
        if !(2..=50).contains(&input.max_calls) || !(1000..=2_000_000).contains(&input.token_budget)
        {
            return Err("调用上限应为 2–50 次，Token 预算应为 1000–2000000".into());
        }
        g.max_calls = input.max_calls;
        g.token_budget = input.token_budget;
        if input.members.len() != g.members.iter().filter(|m| !m.removed).count() {
            return Err("成员配置不完整".into());
        }
        let mut ids = std::collections::HashSet::new();
        for patch in input.members {
            if !ids.insert(patch.id.clone()) {
                return Err("成员配置不能重复".into());
            }
            let m = g
                .members
                .iter_mut()
                .find(|m| m.id == patch.id && !m.removed)
                .ok_or("成员不存在")?;
            if patch.role.chars().count() > 1000 {
                return Err("成员职责不能超过 1000 字".into());
            }
            m.role = patch.role;
            if m.model_id != patch.model_id {
                m.model_id = patch.model_id;
                m.session_id = None;
                m.discussion_session_id = None;
                m.seen_seq = 0;
                m.discussion_seen_seq = 0;
                m.generation += 1;
            }
        }
        Ok(())
    })?;
    changed(&group_id);
    Ok(())
}

pub fn observe(session: &str, update: &Value, meta: Option<&Value>) {
    runtime::observe(session, update, meta);
}
