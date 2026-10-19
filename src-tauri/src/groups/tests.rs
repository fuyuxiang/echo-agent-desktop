use super::*;
pub(super) fn group() -> Group {
    let members = ["协调员", "分析师", "代码专家"]
        .map(|name| Member {
            id: id(),
            name: name.into(),
            expert: Some(name.into()),
            role: name.into(),
            profile: json!({"name":name,"description":name}),
            model_id: "test-model".into(),
            session_id: None,
            discussion_session_id: None,
            seen_seq: 0,
            discussion_seen_seq: 0,
            generation: 0,
            removed: false,
        })
        .to_vec();
    Group {
        id: id(),
        name: "交付组".into(),
        goal: "实现审批".into(),
        cwd: "/isolated".into(),
        source_session_id: None,
        source_team_id: None,
        coordinator_id: members[0].id.clone(),
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
    }
}
fn input() -> SendInput {
    SendInput {
        id: id(),
        text: "请分析需求".into(),
        member_ids: vec![],
        discussion: false,
        attachments: vec![],
        reply_to: None,
        knowledge: Knowledge::default(),
    }
}

#[test]
fn message_retry_is_idempotent_and_routes_to_coordinator() {
    let mut g = group();
    let input = input();
    send(&mut g, &input).unwrap();
    send(&mut g, &input).unwrap();
    assert_eq!(g.messages.len(), 1);
    assert_eq!(g.works.len(), 1);
    assert_eq!(g.works[0].member_id, g.coordinator_id);
}
#[test]
fn explicit_recipients_and_quoted_reply_use_member_identity() {
    let mut g = group();
    let member = g.members[1].id.clone();
    let m = g
        .post(Some(member.clone()), "assistant", "已确认".into(), None)
        .id
        .clone();
    let mut i = input();
    i.reply_to = Some(m);
    send(&mut g, &i).unwrap();
    assert_eq!(g.works[0].member_id, member);
    assert!(g.works[0].prompt.contains("已确认"));
}
#[test]
fn callbacks_wait_for_every_child_and_return_results_to_requester() {
    let mut g = group();
    let coordinator = g.coordinator_id.clone();
    let expert = g.members[1].id.clone();
    let coder = g.members[2].id.clone();
    let p = g
        .enqueue("root", &coordinator, "分工".into(), false, None, 0)
        .unwrap();
    let a = g
        .enqueue("root", &expert, "分析".into(), false, Some(p.clone()), 1)
        .unwrap();
    let b = g
        .enqueue("root", &coder, "实现".into(), false, Some(p.clone()), 1)
        .unwrap();
    g.finish(&p, None, false);
    g.finish(&a, None, false);
    assert_eq!(
        g.works.iter().find(|w| w.id == p).unwrap().status,
        "waiting_children"
    );
    assert!(!g.works.iter().any(|w| w.continuation_of.is_some()));
    g.finish(&b, Some("接口未完成".into()), false);
    let callback = g
        .works
        .iter()
        .find(|w| w.continuation_of.as_deref() == Some(&p))
        .unwrap()
        .clone();
    assert_eq!(callback.member_id, coordinator);
    assert!(callback.prompt.contains("接口未完成"));
    g.finish(&callback.id, None, false);
    assert_eq!(
        g.works.iter().find(|w| w.id == p).unwrap().status,
        "completed"
    );
}
#[test]
fn stopped_generation_never_starts_a_callback() {
    let mut g = group();
    let c = g.coordinator_id.clone();
    let expert = g.members[1].id.clone();
    let p = g
        .enqueue("root", &c, "分工".into(), false, None, 0)
        .unwrap();
    let a = g
        .enqueue("root", &expert, "工作".into(), false, Some(p.clone()), 1)
        .unwrap();
    g.finish(&p, None, false);
    g.epoch += 1;
    g.finish(&a, None, false);
    assert_eq!(g.works.len(), 2);
    assert_eq!(
        g.works.iter().find(|w| w.id == a).unwrap().status,
        "cancelled"
    );
}
#[test]
fn limits_block_runaway_work() {
    let mut g = group();
    let c = g.coordinator_id.clone();
    g.max_calls = 2;
    g.enqueue("root", &c, "a".into(), false, None, 0).unwrap();
    g.enqueue("root", &c, "b".into(), false, None, 0).unwrap();
    assert!(g.enqueue("root", &c, "c".into(), false, None, 0).is_err());
    assert!(g.enqueue("other", &c, "x".into(), false, None, 4).is_err());
}
#[test]
fn store_rolls_back_a_partly_invalid_multi_recipient_send() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("groups.sqlite")).unwrap();
    let g = group();
    store.create(&g).unwrap();
    let mut i = input();
    i.member_ids = vec![g.coordinator_id.clone(), "unknown".into()];
    assert!(store.update(&g.id, |g| send(g, &i)).is_err());
    let restored = store.get(&g.id).unwrap();
    assert!(restored.messages.is_empty());
    assert!(restored.works.is_empty());
}
#[test]
fn recovery_preserves_queued_work_and_marks_unconfirmed_execution() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("groups.sqlite");
    let store = Store::open(&path).unwrap();
    let mut g = group();
    let c = g.coordinator_id.clone();
    let expert = g.members[1].id.clone();
    let running = g
        .enqueue("root", &c, "执行".into(), false, None, 0)
        .unwrap();
    g.enqueue("next", &expert, "后续".into(), false, None, 0)
        .unwrap();
    g.works.iter_mut().find(|w| w.id == running).unwrap().status = "running".into();
    g.members[0].session_id = Some("native-session".into());
    store.create(&g).unwrap();
    drop(store);
    let store = Store::open(&path).unwrap();
    store.recover().unwrap();
    let restored = store.get(&g.id).unwrap();
    assert!(restored.paused);
    assert_eq!(restored.works[0].status, "uncertain");
    assert_eq!(restored.works[1].status, "queued");
    assert_eq!(
        store.owner("native-session").unwrap(),
        Some((g.id, g.coordinator_id))
    );
}
#[test]
fn concurrent_transactions_do_not_lose_messages() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("groups.sqlite")).unwrap();
    let g = group();
    store.create(&g).unwrap();
    let workers = (0..6)
        .map(|n| {
            let store = store.clone();
            let gid = g.id.clone();
            std::thread::spawn(move || {
                for i in 0..6 {
                    store
                        .update(&gid, |g| {
                            g.post(None, "user", format!("{n}:{i}"), None);
                            Ok(())
                        })
                        .unwrap();
                }
            })
        })
        .collect::<Vec<_>>();
    for worker in workers {
        worker.join().unwrap();
    }
    let restored = store.get(&g.id).unwrap();
    assert_eq!(restored.messages.len(), 36);
    assert_eq!(restored.messages.last().unwrap().seq, 36);
}
#[test]
fn group_database_and_member_history_are_isolated() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("groups.sqlite")).unwrap();
    let mut a = group();
    let b = group();
    a.post(None, "user", "仅 A 可见".into(), None);
    store.create(&a).unwrap();
    store.create(&b).unwrap();
    assert!(store.get(&b.id).unwrap().messages.is_empty());
    assert_eq!(store.get(&a.id).unwrap().messages[0].text, "仅 A 可见");
}

#[test]
fn native_events_are_correlated_deduplicated_and_usage_survives_completion() {
    let mut g = group();
    let c = g.coordinator_id.clone();
    let work = g
        .enqueue("root", &c, "执行".into(), false, None, 0)
        .unwrap();
    g.works[0].session_id = Some("native".into());
    g.works[0].status = "running".into();
    let prompt = g.works[0].prompt_id.clone();
    let update = json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"真实输出"},"_groupEventId":"native-event-1"});
    runtime::apply_update(&mut g, "native", &c, &update).unwrap();
    runtime::apply_update(&mut g, "native", &c, &update).unwrap();
    assert_eq!(g.works[0].output, "真实输出");
    assert_eq!(g.messages.len(), 1);
    g.finish(&work, None, false);
    runtime::apply_update(&mut g,"native",&c,&json!({"sessionUpdate":"turn_completed","prompt_id":prompt,"usage":{"inputTokens":120,"outputTokens":30}})).unwrap();
    assert_eq!(g.works[0].tokens, 150);
}
#[test]
fn member_handoffs_are_scoped_idempotent_and_refuse_cycles() {
    let mut g = group();
    let c = g.coordinator_id.clone();
    let expert = g.members[1].id.clone();
    g.enqueue("root", &c, "分工".into(), false, None, 0)
        .unwrap();
    g.works[0].session_id = Some("coordinator-session".into());
    g.works[0].status = "running".into();
    let args =
        json!({"name":"group_call_member","arguments":{"member":expert,"prompt":"分析需求"}});
    let first = mcp::call_in_group(&mut g, &c, "coordinator-session", &args).unwrap();
    let again = mcp::call_in_group(&mut g, &c, "coordinator-session", &args).unwrap();
    assert_eq!(first["workId"], again["workId"]);
    assert_eq!(g.works.len(), 2);
    assert!(mcp::call_in_group(&mut g,&c,"coordinator-session",&json!({"name":"group_call_member","arguments":{"member":"other-group-member","prompt":"越界"}})).is_err());
    g.works[0].status = "waiting_children".into();
    g.works[1].session_id = Some("expert-session".into());
    g.works[1].status = "running".into();
    assert!(mcp::call_in_group(
        &mut g,
        &expert,
        "expert-session",
        &json!({"name":"group_call_member","arguments":{"member":c,"prompt":"循环"}})
    )
    .is_err());
}
#[test]
fn discussion_and_plain_text_mention_routing_are_bounded() {
    let mut g = group();
    let mut i = input();
    i.text = "@代码专家 请评审".into();
    send(&mut g, &i).unwrap();
    assert_eq!(g.works[0].member_id, g.members[2].id);
    assert!(mentioned_targets(&g, "`@代码专家` user@代码专家.com @代码专家.md").is_empty());
    g.works[0].discussion = true;
    g.works[0].session_id = Some("discussion".into());
    g.works[0].status = "running".into();
    let member = g.members[2].id.clone();
    let target = g.members[1].id.clone();
    assert!(mcp::call_in_group(
        &mut g,
        &member,
        "discussion",
        &json!({"name":"group_call_member","arguments":{"member":target,"prompt":"写入"}})
    )
    .is_err());
}

#[test]
fn knowledge_selection_is_explicit_bounded_and_preserved_with_the_request() {
    let mut g = group();
    let mut request = input();
    request.knowledge.context = "private excerpt".into();
    assert!(send(&mut g, &request).is_err());
    assert!(g.messages.is_empty());
    request.knowledge.personal = true;
    request.knowledge.organization_scope_ids = vec!["team-a".into()];
    assert!(send(&mut g, &request).is_err());
    request.knowledge.organization = true;
    send(&mut g, &request).unwrap();
    assert_eq!(g.messages[0].knowledge, request.knowledge);
}

#[test]
fn member_removal_keeps_history_but_cannot_receive_new_work() {
    let mut g = group();
    let member = g.members[1].id.clone();
    g.post(Some(member.clone()), "assistant", "已交付".into(), None);
    g.members[1].removed = true;
    assert!(g
        .enqueue("new", &member, "继续".into(), false, None, 0)
        .is_err());
    assert_eq!(g.messages[0].member_id.as_deref(), Some(member.as_str()));
}

#[test]
fn list_snapshot_keeps_old_active_work_when_newer_history_is_large() {
    let temporary = tempfile::tempdir().unwrap();
    let store = Store::open(&temporary.path().join("groups.sqlite")).unwrap();
    let mut g = group();
    let member = g.members[1].id.clone();
    g.max_calls = 50;
    let running = g
        .enqueue("active-root", &member, "运行中".into(), false, None, 0)
        .unwrap();
    g.works[0].status = "running".into();
    for index in 0..110 {
        let key = g
            .enqueue(
                &format!("root-{index}"),
                &member,
                "旧工作".into(),
                false,
                None,
                0,
            )
            .unwrap();
        g.finish(&key, None, false);
    }
    store.create(&g).unwrap();
    assert!(store.list().unwrap()[0]
        .works
        .iter()
        .any(|w| w.id == running && w.active()));
}

#[test]
fn native_tool_activity_remains_between_the_assistant_messages_it_separates() {
    let mut g = group();
    let member = g.members[1].id.clone();
    g.enqueue("root", &member, "执行".into(), false, None, 0)
        .unwrap();
    g.works[0].session_id = Some("native".into());
    g.works[0].status = "running".into();
    for update in [
        json!({"sessionUpdate":"agent_message_chunk","content":{"text":"先检查"}}),
        json!({"sessionUpdate":"tool_call","toolCallId":"read-1","title":"读取文件","status":"in_progress"}),
        json!({"sessionUpdate":"agent_message_chunk","content":{"text":"结果已确认"}}),
        json!({"sessionUpdate":"tool_call_update","toolCallId":"read-1","status":"completed"}),
    ] {
        runtime::apply_update(&mut g, "native", &member, &update).unwrap();
    }
    assert_eq!(
        g.messages
            .iter()
            .map(|m| m.kind.as_str())
            .collect::<Vec<_>>(),
        ["assistant", "activity", "assistant"]
    );
    assert_eq!(g.messages[1].tool_calls[0]["status"], "completed");
    assert_eq!(g.messages[2].text, "结果已确认");
}

#[test]
fn completing_a_nested_continuation_settles_the_original_request() {
    let mut g = group();
    let coordinator = g.coordinator_id.clone();
    let analyst = g.members[1].id.clone();
    let coder = g.members[2].id.clone();
    let original = g
        .enqueue("root", &coordinator, "交付".into(), false, None, 0)
        .unwrap();
    let first = g
        .enqueue(
            "root",
            &analyst,
            "分析".into(),
            false,
            Some(original.clone()),
            1,
        )
        .unwrap();
    g.finish(&original, None, false);
    g.finish(&first, None, false);
    let resumed = g
        .works
        .iter()
        .find(|w| w.continuation_of.as_deref() == Some(&original))
        .unwrap()
        .id
        .clone();
    let check = g
        .enqueue(
            "root",
            &coder,
            "复核".into(),
            false,
            Some(resumed.clone()),
            1,
        )
        .unwrap();
    g.finish(&resumed, None, false);
    g.finish(&check, None, false);
    let final_work = g
        .works
        .iter()
        .find(|w| w.continuation_of.as_deref() == Some(&resumed))
        .unwrap()
        .id
        .clone();
    g.works
        .iter_mut()
        .find(|w| w.id == final_work)
        .unwrap()
        .output = "交付已验证".into();
    g.finish(&final_work, None, false);
    assert!(g.works.iter().all(|w| w.terminal()));
    assert_eq!(
        g.works.iter().find(|w| w.id == original).unwrap().output,
        "交付已验证"
    );
}

#[test]
fn reaching_a_budget_settles_the_waiting_parent_and_its_queued_continuation() {
    let mut g = group();
    let coordinator = g.coordinator_id.clone();
    let expert = g.members[1].id.clone();
    let parent = g
        .enqueue("root", &coordinator, "交付".into(), false, None, 0)
        .unwrap();
    let child = g
        .enqueue(
            "root",
            &expert,
            "分析".into(),
            false,
            Some(parent.clone()),
            1,
        )
        .unwrap();
    g.finish(&parent, None, false);
    g.works.iter_mut().find(|w| w.id == child).unwrap().tokens = g.token_budget;
    g.finish(&child, None, false);
    g.enforce_budget();
    assert!(g.works.iter().all(|w| w.terminal()));
    assert_eq!(
        g.works.iter().find(|w| w.id == parent).unwrap().status,
        "failed"
    );
}

#[test]
fn duplicate_message_ids_cannot_overwrite_another_group() {
    let temporary = tempfile::tempdir().unwrap();
    let store = Store::open(&temporary.path().join("groups.sqlite")).unwrap();
    let mut first = group();
    let mut second = group();
    let request = input();
    send(&mut first, &request).unwrap();
    store.create(&first).unwrap();
    send(&mut second, &request).unwrap();
    assert!(store.create(&second).is_err());
    assert_eq!(store.get(&first.id).unwrap().messages[0].text, request.text);
    assert!(store.get(&second.id).is_err());
}

#[test]
fn pausing_dispatch_keeps_history_readable_but_refuses_new_handoffs_and_spoofed_members() {
    let mut g = group();
    let coordinator = g.coordinator_id.clone();
    let expert = g.members[1].id.clone();
    g.post(None, "user", "暂停期间仍可查阅的资料".into(), None);
    g.enqueue("root", &coordinator, "交付".into(), false, None, 0)
        .unwrap();
    g.works[0].session_id = Some("native".into());
    g.works[0].status = "running".into();
    g.paused = true;
    let history = json!({"name":"group_read_history","arguments":{}});
    assert!(mcp::call_in_group(&mut g, &coordinator, "native", &history)
        .unwrap()
        .to_string()
        .contains("暂停期间仍可查阅"));
    assert!(mcp::call_in_group(&mut g, &expert, "native", &history).is_err());
    assert!(mcp::call_in_group(
        &mut g,
        &coordinator,
        "native",
        &json!({"name":"group_call_member","arguments":{"member":expert,"prompt":"继续"}})
    )
    .is_err());
}

#[test]
fn historical_session_ownership_survives_a_member_context_reset() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(&directory.path().join("groups.sqlite")).unwrap();
    let mut g = group();
    g.members[0].session_id = Some("previous-context".into());
    store.create(&g).unwrap();
    store
        .update(&g.id, |g| {
            g.members[0].session_id = None;
            g.members[0].generation += 1;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        store.owner("previous-context").unwrap(),
        Some((g.id.clone(), g.members[0].id.clone()))
    );
    store
        .bind_owner("late-cancelled-creation", &g.id, &g.members[0].id)
        .unwrap();
    assert!(store.get(&g.id).unwrap().members[0].session_id.is_none());
    assert_eq!(
        store.owner("late-cancelled-creation").unwrap(),
        Some((g.id, g.members[0].id.clone()))
    );
}

#[test]
fn stopping_a_queued_continuation_settles_the_original_and_never_resumes_it() {
    let mut g = group();
    let parent = g
        .enqueue(
            "root",
            &g.coordinator_id.clone(),
            "原始目标".into(),
            false,
            None,
            0,
        )
        .unwrap();
    let child = g
        .enqueue(
            "root",
            &g.members[1].id.clone(),
            "交付".into(),
            false,
            Some(parent.clone()),
            1,
        )
        .unwrap();
    g.finish(&parent, None, false);
    g.finish(&child, None, false);
    let callback = g
        .works
        .iter()
        .find(|w| w.continuation_of.as_deref() == Some(&parent))
        .unwrap()
        .id
        .clone();
    assert!(g.stop_work(Some(&callback)).unwrap().is_empty());
    assert!(g.works.iter().all(Work::terminal));
    assert_eq!(
        g.works.iter().find(|w| w.id == parent).unwrap().status,
        "cancelled"
    );
    let count = g.works.len();
    g.ready_callbacks();
    assert_eq!(g.works.len(), count);
}

#[test]
fn stopping_session_preparation_never_rebinds_a_replaced_member_context() {
    let mut g = group();
    let work = g
        .enqueue(
            "root",
            &g.coordinator_id.clone(),
            "启动".into(),
            false,
            None,
            0,
        )
        .unwrap();
    g.works[0].status = "dispatching".into();
    g.stop_work(None).unwrap();
    g.members[0].generation += 1;
    g.members[0].model_id = "replacement-model".into();
    assert!(!g.bind_session(&work, "obsolete-native-session"));
    assert!(g.members[0].session_id.is_none());
}

#[test]
fn stop_waits_for_a_running_continuation_and_propagates_its_terminal_state() {
    let mut g = group();
    let parent = g
        .enqueue(
            "root",
            &g.coordinator_id.clone(),
            "协调".into(),
            false,
            None,
            0,
        )
        .unwrap();
    let child = g
        .enqueue(
            "root",
            &g.members[1].id.clone(),
            "执行".into(),
            false,
            Some(parent.clone()),
            1,
        )
        .unwrap();
    g.finish(&parent, None, false);
    g.finish(&child, None, false);
    let callback = g
        .works
        .iter_mut()
        .find(|w| w.continuation_of.as_deref() == Some(&parent))
        .unwrap();
    callback.status = "running".into();
    callback.session_id = Some("native".into());
    let id = callback.id.clone();
    assert_eq!(g.stop_work(Some(&id)).unwrap().len(), 1);
    assert_eq!(
        g.works.iter().find(|w| w.id == id).unwrap().status,
        "stopping"
    );
    g.finish(&id, None, false);
    assert!(g.works.iter().all(Work::terminal));
    assert_eq!(
        g.works.iter().find(|w| w.id == parent).unwrap().status,
        "cancelled"
    );
}

#[test]
fn model_failure_after_dispatch_still_returns_real_results_without_replaying_work() {
    let mut g = group();
    let parent = g
        .enqueue(
            "root",
            &g.coordinator_id.clone(),
            "完成审批交付".into(),
            false,
            None,
            0,
        )
        .unwrap();
    let child = g
        .enqueue(
            "root",
            &g.members[1].id.clone(),
            "交付".into(),
            false,
            Some(parent.clone()),
            1,
        )
        .unwrap();
    g.finish(&parent, Some("模型连接中断".into()), false);
    assert_eq!(
        g.works.iter().find(|w| w.id == parent).unwrap().status,
        "waiting_children"
    );
    g.works.iter_mut().find(|w| w.id == child).unwrap().output = "文件已生成并验证".into();
    g.finish(&child, None, false);
    let callback = g
        .works
        .iter()
        .find(|w| w.continuation_of.as_deref() == Some(&parent))
        .unwrap()
        .clone();
    assert!(callback.prompt.contains("完成审批交付"));
    assert!(callback.prompt.contains("模型连接中断"));
    assert!(callback.prompt.contains("文件已生成并验证"));
    g.finish(&callback.id, None, false);
    assert!(g.works.iter().all(Work::terminal));
    assert_eq!(g.works.len(), 3);
    assert!(g
        .works
        .iter()
        .find(|w| w.id == parent)
        .unwrap()
        .error
        .is_none());
}

#[test]
fn recovery_repairs_legacy_dependency_states_and_pauses_before_any_dispatch() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("groups.sqlite")).unwrap();
    let mut g = group();
    let parent = g
        .enqueue(
            "root",
            &g.coordinator_id.clone(),
            "旧请求".into(),
            false,
            None,
            0,
        )
        .unwrap();
    let child = g
        .enqueue(
            "root",
            &g.members[1].id.clone(),
            "交付".into(),
            false,
            Some(parent.clone()),
            1,
        )
        .unwrap();
    g.finish(&parent, None, false);
    g.finish(&child, None, false);
    g.works
        .iter_mut()
        .find(|w| w.continuation_of.as_deref() == Some(&parent))
        .unwrap()
        .status = "cancelled".into();
    let other = g
        .enqueue(
            "other",
            &g.coordinator_id.clone(),
            "异常请求".into(),
            false,
            None,
            0,
        )
        .unwrap();
    g.enqueue(
        "other",
        &g.members[1].id.clone(),
        "尚未执行".into(),
        false,
        Some(other.clone()),
        1,
    )
    .unwrap();
    let w = g.works.iter_mut().find(|w| w.id == other).unwrap();
    w.status = "failed".into();
    w.error = Some("旧版本模型异常".into());
    store.create(&g).unwrap();
    store.recover().unwrap();
    let restored = store.get(&g.id).unwrap();
    assert_eq!(
        restored
            .works
            .iter()
            .find(|w| w.id == parent)
            .unwrap()
            .status,
        "cancelled"
    );
    assert_eq!(
        restored
            .works
            .iter()
            .find(|w| w.id == other)
            .unwrap()
            .status,
        "waiting_children"
    );
    assert!(restored.paused);
    assert_eq!(restored.works.len(), g.works.len());
}

#[tokio::test]
async fn stop_during_preparation_fences_a_delayed_native_prompt() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("groups.sqlite")).unwrap();
    let mut g = group();
    let work = g
        .enqueue(
            "root",
            &g.coordinator_id.clone(),
            "写入文件".into(),
            false,
            None,
            0,
        )
        .unwrap();
    g.works[0].status = "dispatching".into();
    g.works[0].session_id = Some("native".into());
    let prompt_id = g.works[0].prompt_id.clone();
    store.create(&g).unwrap();
    let gate = runtime::dispatch_lock(&g.id).lock_owned().await;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let pending = tokio::spawn({
        let store = store.clone();
        let id = g.id.clone();
        let work = work.clone();
        async move {
            runtime::dispatch_prompt(
                &store,
                &id,
                &work,
                &tx,
                crate::agent_runtime::GroupPromptRequest {
                    session: "native",
                    prompt_id: &prompt_id,
                    text: "写入文件",
                    attachments: &[],
                },
            )
            .await
        }
    });
    store
        .update(&g.id, |g| {
            assert!(g.stop_work(None)?.is_empty());
            Ok(())
        })
        .unwrap();
    drop(gate);
    assert!(pending.await.unwrap().unwrap().is_none());
    assert!(rx.try_recv().is_err());
    assert_eq!(store.get(&g.id).unwrap().works[0].status, "cancelled");
}

#[tokio::test]
async fn paused_preparation_returns_to_queue_and_dispatch_enqueues_before_awaiting_the_model() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("groups.sqlite")).unwrap();
    let mut g = group();
    let work = g
        .enqueue(
            "root",
            &g.coordinator_id.clone(),
            "分析".into(),
            true,
            None,
            0,
        )
        .unwrap();
    g.works[0].status = "dispatching".into();
    g.paused = true;
    let prompt_id = g.works[0].prompt_id.clone();
    store.create(&g).unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    assert!(runtime::dispatch_prompt(
        &store,
        &g.id,
        &work,
        &tx,
        crate::agent_runtime::GroupPromptRequest {
            session: "native",
            prompt_id: &prompt_id,
            text: "分析",
            attachments: &[],
        },
    )
    .await
    .unwrap()
    .is_none());
    assert!(rx.try_recv().is_err());
    assert_eq!(store.get(&g.id).unwrap().works[0].status, "queued");
    store
        .update(&g.id, |g| {
            g.paused = false;
            g.works[0].status = "dispatching".into();
            Ok(())
        })
        .unwrap();
    let pending = runtime::dispatch_prompt(
        &store,
        &g.id,
        &work,
        &tx,
        crate::agent_runtime::GroupPromptRequest {
            session: "native",
            prompt_id: &prompt_id,
            text: "分析",
            attachments: &[],
        },
    )
    .await
    .unwrap()
    .unwrap();
    let echo_agent_acp::AcpAgentMessage::Prompt(args) = rx.try_recv().unwrap() else {
        panic!("expected native prompt");
    };
    assert_eq!(args.request.session_id.0.as_ref(), "native");
    args.response_tx
        .send(Ok(agent_client_protocol::PromptResponse::new(
            agent_client_protocol::StopReason::EndTurn,
        )))
        .unwrap();
    pending.complete().await.unwrap();
    assert_eq!(store.get(&g.id).unwrap().works[0].status, "running");
}

#[test]
fn group_delete_cascades_records_and_ownership_but_keeps_templates_and_other_groups() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("groups.sqlite")).unwrap();
    let mut first = group();
    first.members[0].session_id = Some("native-current".into());
    first.post(None, "user", "需要删除的记录".into(), None);
    let work = first
        .enqueue(
            "request",
            &first.coordinator_id.clone(),
            "工作".into(),
            false,
            None,
            0,
        )
        .unwrap();
    first.finish(&work, None, false);
    store.create(&first).unwrap();
    store
        .bind_owner("native-old-workspace", &first.id, &first.members[0].id)
        .unwrap();
    store
        .stage_session_delete(&first.id, "native-old-workspace", "/old")
        .unwrap();
    let other = group();
    store.create(&other).unwrap();
    let template = management::TeamTemplate {
        id: id(),
        name: "保留模板".into(),
        description: "".into(),
        source: "常用团队".into(),
        members: vec![],
        coordinator_name: None,
        coordinator_role: None,
        default_model_id: None,
    };
    store.save_template(&template).unwrap();
    assert_eq!(store.sessions(&first.id).unwrap().len(), 2);
    store.delete(&first.id).unwrap();
    assert!(store.get(&first.id).is_err());
    assert!(store.owner("native-current").unwrap().is_none());
    assert!(store.owner("native-old-workspace").unwrap().is_none());
    assert!(store.deletion_sessions(&first.id).unwrap().is_empty());
    let receipts = Store::open(&store.path).unwrap().pending_cleanup().unwrap();
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].group_id, first.id);
    assert!(receipts[0]
        .session_ids
        .contains(&"native-current".to_string()));
    store.ack_cleanup(&first.id).unwrap();
    assert!(store.pending_cleanup().unwrap().is_empty());
    assert!(store.get(&other.id).is_ok());
    assert_eq!(store.templates().unwrap()[0].id, template.id);
    store
        .bind_owner("late-session", &first.id, &first.members[0].id)
        .unwrap();
    assert!(store.owner("late-session").unwrap().is_none());
}

#[test]
fn group_delete_refuses_unfinished_work_without_removing_history() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("groups.sqlite")).unwrap();
    let mut g = group();
    g.post(None, "user", "保留我的记录".into(), None);
    g.enqueue(
        "request",
        &g.coordinator_id.clone(),
        "未完成".into(),
        false,
        None,
        0,
    )
    .unwrap();
    store.create(&g).unwrap();
    assert!(store.delete(&g.id).unwrap_err().contains("尚未确认停止"));
    assert_eq!(store.get(&g.id).unwrap().messages.len(), 1);
}

#[test]
fn group_catalog_does_not_lose_older_groups_behind_five_hundred_archives() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("groups.sqlite")).unwrap();
    let mut old = group();
    old.updated_at = 1;
    store.create(&old).unwrap();
    for index in 0..500 {
        let mut g = group();
        g.archived = true;
        g.updated_at = index + 2;
        store.create(&g).unwrap();
    }
    let groups = store.list().unwrap();
    assert_eq!(groups.len(), 501);
    assert!(groups.iter().any(|g| g.id == old.id && !g.archived));
}

#[test]
fn catalog_previews_exclude_expert_and_decision_history_without_altering_snapshots() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("groups.sqlite")).unwrap();
    let mut g = group();
    g.members[0].profile = json!({"promptBody":"private expert instructions"});
    g.post(None, "user", "请求".into(), None).knowledge.context = "private knowledge".into();
    g.decisions.push(Decision {
        id: id(),
        text: "有效决定".into(),
        message_id: None,
        created_at: now(),
        confirmed: true,
        voided: false,
        history: vec![],
        updated_at: None,
    });
    store.create(&g).unwrap();
    let preview = store.list().unwrap().remove(0);
    assert!(preview.decisions.is_empty());
    assert_eq!(preview.members[0].profile, json!({}));
    assert!(preview.messages[0].knowledge.context.is_empty());
    let full = store.get(&g.id).unwrap();
    assert_eq!(full.members[0].profile, g.members[0].profile);
    assert_eq!(full.decisions.len(), 1);
    assert_eq!(full.messages[0].knowledge.context, "private knowledge");
}

#[test]
fn decisions_can_be_corrected_voided_and_restored_with_audit_history() {
    let mut g = group();
    for index in 0..101 {
        g.decisions.push(Decision {
            id: index.to_string(),
            text: "旧决定".into(),
            message_id: None,
            created_at: now(),
            confirmed: true,
            voided: false,
            history: vec![],
            updated_at: None,
        });
    }
    management::change_decision(&mut g, "100", "edit", Some("更正后的决定")).unwrap();
    assert_eq!(g.decisions[100].text, "更正后的决定");
    assert_eq!(g.decisions[100].history[0].text, "旧决定");
    management::change_decision(&mut g, "100", "void", None).unwrap();
    assert!(g.decisions[100].voided);
    assert!(
        management::change_decision(&mut g, "100", "edit", Some("不能偷偷更改作废记录")).is_err()
    );
    management::change_decision(&mut g, "100", "restore", None).unwrap();
    assert!(!g.decisions[100].voided);
    assert!(management::change_decision(&mut g, "100", "edit", Some(" ")).is_err());
}

#[test]
fn decision_context_uses_current_versions_and_bounds_prompt_without_losing_history() {
    let mut g = group();
    g.decisions.push(Decision {
        id: id(),
        text: "当前决定".into(),
        message_id: None,
        created_at: now(),
        confirmed: true,
        voided: false,
        history: vec![DecisionVersion {
            action: "edit".into(),
            text: "已过期的旧决定".into(),
            changed_at: now(),
        }],
        updated_at: None,
    });
    let context = runtime::decision_context(&g).unwrap();
    assert!(context.contains("当前决定"));
    assert!(!context.contains("已过期的旧决定"));
    g.decisions[0].text = "长".repeat(24_001);
    assert!(runtime::decision_context(&g).is_err());
    assert_eq!(g.decisions[0].text.chars().count(), 24_001);
    g.decisions[0].voided = true;
    assert!(runtime::decision_context(&g).is_ok());
}

#[test]
fn group_memory_cleanup_removes_only_the_owned_namespace_and_can_be_retried() {
    let home = tempfile::tempdir().unwrap();
    let owned = home
        .path()
        .join("group-memory/owned-group/member/generation-1");
    let other = home.path().join("group-memory/another-group");
    let experts = home.path().join("agents");
    for path in [&owned, &other, &experts] {
        std::fs::create_dir_all(path).unwrap();
        std::fs::write(path.join("MEMORY.md"), "保留相应范围的记忆").unwrap();
    }
    remove_group_memory(home.path(), "owned-group").unwrap();
    assert!(!home.path().join("group-memory/owned-group").exists());
    assert!(other.join("MEMORY.md").exists());
    assert!(experts.join("MEMORY.md").exists());
    remove_group_memory(home.path(), "owned-group").unwrap();
    assert!(remove_group_memory(home.path(), "../agents").is_err());
    #[cfg(unix)]
    {
        let linked = home.path().join("group-memory/linked-group");
        std::os::unix::fs::symlink(&experts, &linked).unwrap();
        assert!(remove_group_memory(home.path(), "linked-group").is_err());
        assert!(experts.join("MEMORY.md").exists());
        let redirected = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(
            home.path().join("group-memory"),
            redirected.path().join("group-memory"),
        )
        .unwrap();
        assert!(remove_group_memory(redirected.path(), "another-group").is_err());
        assert!(other.join("MEMORY.md").exists());
    }
}

#[test]
fn template_library_only_contains_explicit_saves_and_is_independent_of_session_teams() {
    if std::env::var_os("ECHOAGENT_TEMPLATE_LIBRARY_TEST").is_none() {
        let home = tempfile::tempdir().unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "groups::tests::template_library_only_contains_explicit_saves_and_is_independent_of_session_teams"])
            .env("ECHO_AGENT_HOME", home.path())
            .env("ECHOAGENT_TEMPLATE_LIBRARY_TEST", "1")
            .status().unwrap();
        assert!(status.success());
        return;
    }
    let home = crate::paths::echo_agent_home_dir();
    let store = Store::open(&home.join("collaboration.sqlite")).unwrap();
    assert!(STORE.set(store.clone()).is_ok());
    // Unreadable session assignments must not make saved templates unreadable.
    std::fs::write(
        home.join("echoagent-teams.json"),
        "invalid historical teams",
    )
    .unwrap();
    assert!(management::group_team_templates().unwrap().is_empty());
    let mut original = group();
    original.members[1].role = "分析与验收".into();
    original.members[1].model_id = "member-model".into();
    store.create(&original).unwrap();
    let saved = management::group_team_save(original.id.clone(), "复用模板".into()).unwrap();
    assert_eq!(saved.members[1].role, "分析与验收");
    assert_eq!(saved.members[1].model_id.as_deref(), Some("member-model"));
    assert_eq!(saved.coordinator_name.as_deref(), Some("协调员"));
    let updated = management::group_team_save(original.id.clone(), "复用模板".into()).unwrap();
    assert_eq!(updated.id, saved.id);
    assert_eq!(management::group_team_templates().unwrap().len(), 1);
    management::group_team_delete(saved.id).unwrap();
    assert!(management::group_team_templates().unwrap().is_empty());
    assert!(store.get(&original.id).is_ok());
}

#[test]
fn source_creation_is_atomic_idempotent_and_includes_archived_groups() {
    let dir = tempfile::tempdir().unwrap();
    let store = store::Store::open(&dir.path().join("groups.sqlite")).unwrap();
    let mut original = group();
    original.source_session_id = Some("source".into());
    original.source_team_id = Some("team".into());
    original.archived = true;
    let attempts: Vec<_> = (0..6)
        .map(|_| {
            let store = store.clone();
            let mut candidate = original.clone();
            candidate.id = id();
            std::thread::spawn(move || store.create(&candidate).unwrap().id)
        })
        .collect();
    let ids: Vec<_> = attempts.into_iter().map(|a| a.join().unwrap()).collect();
    assert!(ids.iter().all(|id| id == &ids[0]));
    assert_eq!(store.list().unwrap().len(), 1);
    let existing = store.get(&ids[0]).unwrap();
    assert!(existing.archived);
    assert_eq!(store.create(&existing).unwrap().id, existing.id);
    let mut other = original;
    other.source_session_id = Some("other-source".into());
    store.create(&other).unwrap();
    assert_eq!(store.list().unwrap().len(), 2);
}
