use super::*;
pub(super) fn tools() -> Value {
    let tool = |name: &str, description: &str, properties: Value, required: Vec<&str>| json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false}});
    json!({"tools":[
        tool("group_call_member","Assign work to another member of this group. Returns immediately; finish your turn, the Runtime resumes you when results are back. Use exact member id or name from group context.",json!({"member":{"type":"string"},"prompt":{"type":"string"}}),vec!["member","prompt"]),
        tool("group_read_history","Read this group's messages, oldest first. Other groups and private chats are not accessible.",json!({"after":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":50}}),vec![]),
        tool("group_get_work","Read the status and result of work in this group. Do not poll pending work; results are returned to its requester automatically.",json!({"workId":{"type":"string"}}),vec!["workId"]),
        tool("group_record_decision","Propose a decision citing the user message id. It becomes confirmed only when the user confirms it in the group.",json!({"text":{"type":"string"},"messageId":{"type":"string"}}),vec!["text","messageId"])
    ]})
}
pub(super) fn call(session: &str, params: &Value) -> Result<Value, String> {
    let (gid, member) = session_owner(session).ok_or("该会话不是群成员")?;
    let result = db()?.update(&gid, |g| call_in_group(g, &member, session, params))?;
    changed(&gid);
    if let Some(app) = APP.get() {
        runtime::kick(app.clone(), gid);
    }
    Ok(
        json!({"content":[{"type":"text","text":serde_json::to_string(&result).map_err(|e|e.to_string())?}],"isError":false}),
    )
}

pub(super) fn call_in_group(
    g: &mut Group,
    member: &str,
    session: &str,
    params: &Value,
) -> Result<Value, String> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or("工具名缺失")?;
    let args = params.get("arguments").cloned().unwrap_or(json!({}));
    let work = g
        .works
        .iter()
        .find(|w| {
            w.session_id.as_deref() == Some(session)
                && w.member_id == member
                && w.status == "running"
        })
        .cloned()
        .ok_or("没有正在执行的专家团内请求")?;
    if work.epoch != g.epoch || g.archived {
        return Err("专家团内协作已停止".into());
    }
    match name {
        "group_call_member" => {
            if g.paused {
                return Err("后续派发已暂停，请等待用户恢复协作".into());
            }
            if work.discussion {
                return Err("讨论回合不能派发执行工作".into());
            }
            let target = args
                .get("member")
                .and_then(Value::as_str)
                .ok_or("请指定成员")?;
            let target = g
                .members
                .iter()
                .find(|m| !m.removed && (m.id == target || m.name == target))
                .map(|m| m.id.clone())
                .ok_or("成员不在本专家团中")?;
            if target == member {
                return Err("不能向自己派发工作".into());
            }
            let mut cursor = Some(work.id.clone());
            while let Some(id) = cursor {
                let Some(parent) = g.works.iter().find(|w| w.id == id) else {
                    break;
                };
                if parent.member_id == target {
                    return Err("该成员正在等待此项工作，不能形成循环依赖".into());
                }
                cursor = parent.parent_id.clone();
            }
            let prompt = text(
                args.get("prompt").and_then(Value::as_str).unwrap_or(""),
                20000,
                "工作说明",
            )?;
            if let Some(existing) = g.works.iter().find(|w| {
                w.parent_id.as_deref() == Some(&work.id)
                    && w.member_id == target
                    && w.prompt == prompt
            }) {
                return Ok(json!({"workId":existing.id,"status":existing.status}));
            }
            let id = g.enqueue(
                &work.root_id,
                &target,
                prompt.clone(),
                false,
                Some(work.id.clone()),
                work.depth + 1,
            )?;
            g.post(
                Some(member.to_string()),
                "handoff",
                prompt,
                Some(id.clone()),
            );
            Ok(
                json!({"workId":id,"status":"queued","note":"End this turn. You will receive the results automatically."}),
            )
        }
        "group_read_history" => {
            let after = args.get("after").and_then(Value::as_u64).unwrap_or(0);
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(30)
                .clamp(1, 50) as usize;
            Ok(json!(g.messages.iter().filter(|m|m.seq>after).take(limit).map(|m|json!({"id":m.id,"seq":m.seq,"memberId":m.member_id,"text":m.text.chars().take(10000).collect::<String>()})).collect::<Vec<_>>()))
        }
        "group_get_work" => {
            let id = args.get("workId").and_then(Value::as_str).unwrap_or("");
            let w = g
                .works
                .iter()
                .find(|w| w.id == id)
                .ok_or("工作不属于本专家团或不存在")?;
            Ok(json!({"id":w.id,"status":w.status,"output":w.output,"error":w.error}))
        }
        "group_record_decision" => {
            let source = args.get("messageId").and_then(Value::as_str).unwrap_or("");
            if !g
                .messages
                .iter()
                .any(|m| m.id == source && m.kind == "user")
            {
                return Err("决定必须引用用户在本专家团的消息".into());
            }
            let text = text(
                args.get("text").and_then(Value::as_str).unwrap_or(""),
                2000,
                "决定",
            )?;
            let d = Decision {
                id: id(),
                text,
                message_id: Some(source.into()),
                created_at: now(),
                confirmed: false,
                voided: false,
                history: vec![],
                updated_at: None,
            };
            let result = json!(d);
            g.decisions.push(d);
            Ok(result)
        }
        _ => Err("该工具不属于群协作工具".into()),
    }
}
