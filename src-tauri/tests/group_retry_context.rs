// Run the production group state machine without starting a desktop or Runtime.
extern crate self as echo_agent_memory;
#[path = "../src/groups/model.rs"]
mod model;
#[path = "../../vendor/echo-agent-build/crates/codegen/echo-agent-memory/src/text_utils.rs"]
pub mod text_utils;

use model::{Group, Member};

fn fixture(discussion: bool) -> (Group, String) {
    let member = Member {
        id: "member-a".into(),
        name: "A".into(),
        expert: Some("A".into()),
        role: "delivery".into(),
        profile: serde_json::json!({}),
        model_id: "M3".into(),
        session_id: Some("execution-before-stop".into()),
        discussion_session_id: Some("discussion-before-stop".into()),
        seen_seq: 9,
        discussion_seen_seq: 8,
        generation: 4,
        history_start_seq: 3,
        removed: false,
    };
    let mut group = Group {
        id: "group".into(),
        name: "QA".into(),
        goal: "bounded delivery".into(),
        cwd: "/isolated".into(),
        source_session_id: None,
        source_team_id: None,
        coordinator_id: member.id.clone(),
        permission_mode: "ask".into(),
        members: vec![member],
        messages: vec![],
        works: vec![],
        decisions: vec![],
        archived: false,
        pinned: false,
        paused: false,
        epoch: 0,
        revision: 1,
        created_at: 0,
        updated_at: 0,
        max_calls: 4,
        token_budget: 500_000,
    };
    let work = group
        .enqueue(
            "request",
            "member-a",
            "create exact file".into(),
            discussion,
            None,
            0,
        )
        .unwrap();
    let sid = if discussion {
        "discussion-before-stop"
    } else {
        "execution-before-stop"
    };
    group.works[0].session_id = Some(sid.into());
    group.works[0].status = "cancelled".into();
    group
        .post(None, "user", "create exact file".into(), None)
        .id = "request".into();
    (group, work)
}

#[test]
fn cancelled_execution_retry_uses_fresh_actor_without_erasing_memory_or_history() {
    let (mut group, work) = fixture(false);
    let old = group.members[0].clone();
    group.retry_work(&work).unwrap();
    let member = &group.members[0];
    assert_eq!(
        member.session_id, None,
        "a cancelled actor must not own the retry's next permission request"
    );
    assert_eq!(member.discussion_session_id, old.discussion_session_id);
    assert_eq!(
        member.generation, old.generation,
        "long-term memory must survive retry"
    );
    assert_eq!(member.history_start_seq, old.history_start_seq);
    assert_eq!(member.seen_seq, member.history_start_seq);
    assert_eq!(member.model_id, old.model_id);
    assert_eq!(
        group.works[0].session_id.as_deref(),
        Some("execution-before-stop")
    );
    assert_eq!(group.works[0].status, "cancelled");
    assert!(group
        .works
        .last()
        .unwrap()
        .prompt
        .contains("create exact file"));
    assert_eq!(group.messages.len(), 2);
}

#[test]
fn cancelled_discussion_retry_retires_only_discussion_context() {
    let (mut group, work) = fixture(true);
    let old = group.members[0].clone();
    group.retry_work(&work).unwrap();
    let member = &group.members[0];
    assert_eq!(member.discussion_session_id, None);
    assert_eq!(member.session_id, old.session_id);
    assert_eq!(member.discussion_seen_seq, member.history_start_seq);
    assert_eq!(member.generation, old.generation);
}

#[test]
fn retry_of_old_cancelled_work_keeps_a_newer_member_context() {
    let (mut group, work) = fixture(false);
    group.members[0].session_id = Some("newer-context".into());
    group.retry_work(&work).unwrap();
    assert_eq!(
        group.members[0].session_id.as_deref(),
        Some("newer-context")
    );
}

#[test]
fn retry_never_retires_a_context_owned_by_other_active_work() {
    let (mut group, work) = fixture(false);
    group
        .enqueue(
            "new-request",
            "member-a",
            "current work".into(),
            false,
            None,
            0,
        )
        .unwrap();
    group.works[1].status = "running".into();
    group.works[1].session_id = group.members[0].session_id.clone();
    let old = group.members[0].clone();
    group.retry_work(&work).unwrap();
    assert_eq!(group.members[0], old);
}

#[test]
fn failed_model_request_keeps_its_completed_context_for_normal_retry() {
    let (mut group, work) = fixture(false);
    group.works[0].status = "failed".into();
    let old = group.members[0].clone();
    group.retry_work(&work).unwrap();
    assert_eq!(group.members[0], old);
}
