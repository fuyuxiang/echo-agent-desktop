//! Runs the real embedded Runtime against an isolated loopback model. No user
//! data, provider credentials, or paid inference is used by this test.
use super::*;
use axum::{extract::State as AxumState, response::IntoResponse, routing::post, Json, Router};
use std::sync::{Arc, Mutex};

#[test]
fn native_runtime_group_contract() {
    let home = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "groups::native_smoke::isolated_native_runtime",
            "--exact",
            "--nocapture",
        ])
        .env("ECHO_GROUP_NATIVE_TEST", "1")
        .env("ECHO_AGENT_HOME", home.path())
        .env("GROK_HOME", home.path().join("empty-legacy"))
        .env_remove("HTTP_PROXY")
        .env_remove("HTTPS_PROXY")
        .env_remove("ALL_PROXY")
        .env_remove("http_proxy")
        .env_remove("https_proxy")
        .env_remove("all_proxy")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "Native group integration failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

async fn model(
    AxumState(requests): AxumState<Arc<Mutex<Vec<Value>>>>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    requests.lock().unwrap().push(body.clone());
    if body.get("stream").and_then(Value::as_bool) == Some(true) {
        let first = json!({"id":"group-test","object":"chat.completion.chunk","created":1,"model":"mock","choices":[{"index":0,"delta":{"role":"assistant","content":"原生群聊执行成功"},"finish_reason":null}]});
        let last = json!({"id":"group-test","object":"chat.completion.chunk","created":1,"model":"mock","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":6,"total_tokens":18}});
        (
            [("content-type", "text/event-stream")],
            format!("data: {first}\n\ndata: {last}\n\ndata: [DONE]\n\n"),
        )
            .into_response()
    } else {
        Json(json!({"id":"group-test","object":"chat.completion","created":1,"model":"mock","choices":[{"index":0,"message":{"role":"assistant","content":"原生群聊执行成功"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":6,"total_tokens":18}})).into_response()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn isolated_native_runtime() {
    if std::env::var("ECHO_GROUP_NATIVE_TEST").as_deref() != Ok("1") {
        return;
    }
    let requests = Arc::new(Mutex::new(vec![]));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let router = Router::new()
        .route("/v1/chat/completions", post(model))
        .with_state(requests.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let home = crate::paths::echo_agent_home_dir();
    std::fs::create_dir_all(&home).unwrap();
    std::fs::write(
        home.join("config.toml"),
        format!(
            r#"
[models]
default = "group-test/mock"
[model_providers.group-test]
provider_kind = "custom"
base_url = "http://127.0.0.1:{port}/v1"
api_key = "isolated-local-model"
api_backend = "chat_completions"
auth_scheme = "bearer"
context_window = 131072
[model."group-test/mock"]
model = "mock"
model_provider = "group-test"
name = "Group integration model"
max_completion_tokens = 1024
[memory]
enabled = false
"#
        ),
    )
    .unwrap();
    let workspace = tempfile::tempdir().unwrap();
    crate::team_mcp::serve();
    let handle = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        tokio::task::spawn_blocking({
            let cwd = workspace.path().to_path_buf();
            move || crate::agent_runtime::spawn_agent_runtime(cwd)
        }),
    )
    .await
    .unwrap()
    .unwrap()
    .unwrap();
    let crate::agent_runtime::AgentHandle {
        tx,
        mut rx,
        cancel,
        mut shutdown_complete,
        ..
    } = handle;
    let chunks = Arc::new(Mutex::new(String::new()));
    let captured = chunks.clone();
    let dispatcher = tokio::spawn(async move {
        use echo_agent_acp::AcpClientMessage;
        while let Some(message) = rx.recv().await {
            match message {
                AcpClientMessage::SessionNotification(args) => {
                    if let Ok(value) = serde_json::to_value(&args.request.update) {
                        let meta = args
                            .request
                            .meta
                            .as_ref()
                            .and_then(|m| serde_json::to_value(m).ok());
                        super::observe(args.request.session_id.0.as_ref(), &value, meta.as_ref());
                        if let Some(text) = value.pointer("/content/text").and_then(Value::as_str) {
                            captured.lock().unwrap().push_str(text);
                        }
                    }
                    let _ = args.response_tx.send(Ok(()));
                }
                AcpClientMessage::ExtNotification(args) => {
                    if let Ok(params) = serde_json::from_str::<Value>(args.request.params.get()) {
                        if let (Some(session), Some(update)) = (
                            params.get("sessionId").and_then(Value::as_str),
                            params.get("update"),
                        ) {
                            super::observe(session, update, params.get("_meta"));
                        }
                    }
                    let _ = args.response_tx.send(Ok(()));
                }
                AcpClientMessage::ExtMethod(args) => {
                    let _ = args
                        .response_tx
                        .send(Ok(agent_client_protocol::ExtResponse::new(
                            crate::ext::raw_params(&json!({})),
                        )));
                }
                AcpClientMessage::RequestPermission(args) => {
                    let _ = args.response_tx.send(Ok(
                        agent_client_protocol::RequestPermissionResponse::new(
                            agent_client_protocol::RequestPermissionOutcome::Cancelled,
                        ),
                    ));
                }
                _ => panic!("Native group unexpectedly requested host filesystem/terminal IO"),
            }
        }
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(30),
        crate::agent_runtime::initialize(&tx),
    )
    .await
    .unwrap()
    .unwrap();
    let profile = json!({"name":echo_agent_core::AgentDefinition::default_echo_agent_build().name,"description":"native test expert","promptMode":"extend","promptBody":"GROUP_ROLE_MUST_SURVIVE_RESTORE"});
    let store = Store::open(&home.join("collaboration.sqlite")).unwrap();
    let mut group = super::tests::group();
    group.cwd = workspace.path().to_string_lossy().into_owned();
    let gid = group.id.clone();
    let member = group.coordinator_id.clone();
    group.post(None, "user", "本群可见的目标".into(), None);
    let work = group
        .enqueue("root", &member, "请确认身份".into(), true, None, 0)
        .unwrap();
    store.create(&group).unwrap();
    assert!(STORE.set(store).is_ok());
    // Runtime fetches tools before a newly allocated session can be bound in
    // SQLite. Authenticated group/member headers must already select group tools.
    let client = reqwest::Client::new();
    let catalog: Value = client
        .post(crate::team_mcp::server_url().unwrap())
        .header(
            crate::team_mcp::AUTH_HEADER,
            crate::team_mcp::authorization_header().unwrap(),
        )
        .header("X-EchoAgent-Group-Id", &gid)
        .header("X-EchoAgent-Member-Id", &member)
        .json(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(catalog["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["name"] == "group_call_member"));
    assert!(!catalog["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["name"] == "create_team"));
    let sid = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        crate::agent_runtime::group_session(
            &tx,
            workspace.path(),
            "group-test/mock",
            &profile,
            &gid,
            &member,
            0,
            true,
            None,
        ),
    )
    .await
    .unwrap()
    .unwrap();
    db().unwrap()
        .update(&gid, |g| {
            g.members[0].discussion_session_id = Some(sid.clone());
            let w = g.works.iter_mut().find(|w| w.id == work).unwrap();
            w.session_id = Some(sid.clone());
            w.prompt_id = "prompt-1".into();
            w.status = "running".into();
            Ok(())
        })
        .unwrap();
    remember_owner(&sid, &gid, &member);
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        crate::agent_runtime::group_prompt(&tx, &sid, "prompt-1", "请确认身份", &[]),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(!matches!(
        result.stop_reason.as_str(),
        "error" | "rate_limit"
    ));
    assert!(chunks.lock().unwrap().contains("原生群聊执行成功"));
    super::runtime::flush(&sid);
    let saved = db().unwrap().get(&gid).unwrap();
    assert!(saved.works[0].output.contains("原生群聊执行成功"));
    let history: Value = client.post(crate::team_mcp::server_url().unwrap())
        .header(crate::team_mcp::AUTH_HEADER, crate::team_mcp::authorization_header().unwrap())
        .header(crate::team_mcp::SESSION_HEADER, &sid)
        .json(&json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"group_read_history","arguments":{}}}))
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(history["result"]["isError"], false);
    assert!(history.to_string().contains("本群可见的目标"));
    db().unwrap()
        .update(&gid, |g| {
            g.finish(&work, None, false);
            let next = g.enqueue("root-2", &member, "继续确认".into(), true, None, 0)?;
            let w = g.works.iter_mut().find(|w| w.id == next).unwrap();
            w.session_id = Some(sid.clone());
            w.prompt_id = "prompt-2".into();
            w.status = "running".into();
            Ok(())
        })
        .unwrap();
    // Drop the actor so the next load exercises disk restore, not a resident
    // session that already happened to have the correct expert definition.
    let closed: Value = crate::ext::call_ext(
        &tx,
        "echo.agent/session/close",
        crate::ext::raw_params(&json!({"sessionId":sid})),
    )
    .await
    .unwrap();
    assert_eq!(closed["outcome"], "closed");
    crate::agent_runtime::group_session(
        &tx,
        workspace.path(),
        "group-test/mock",
        &profile,
        &gid,
        &member,
        0,
        true,
        Some(&sid),
    )
    .await
    .unwrap();
    crate::agent_runtime::group_prompt(&tx, &sid, "prompt-2", "继续确认身份", &[])
        .await
        .unwrap();
    {
        let calls = requests.lock().unwrap();
        let role_calls = calls
            .iter()
            .filter(|request| {
                request
                    .to_string()
                    .contains("GROUP_ROLE_MUST_SURVIVE_RESTORE")
            })
            .collect::<Vec<_>>();
        assert!(
            role_calls.len() >= 2,
            "Expert role was lost: {} model calls",
            calls.len()
        );
        for call in role_calls {
            for tool in call
                .get("tools")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let name = tool
                    .pointer("/function/name")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let name = name
                    .rsplit("__")
                    .next()
                    .unwrap_or(name)
                    .rsplit(':')
                    .next()
                    .unwrap_or(name);
                assert!(
                    !matches!(
                        name,
                        "run_terminal_command" | "edit_file" | "write_file" | "use_tool" | "task"
                    ),
                    "Discussion exposed mutating tool {name}"
                );
            }
        }
    }
    // Execution keeps ordinary Runtime capabilities, while the host owns every
    // multi-agent dispatch and its lifetime. Native goals/workflows/subagents
    // must not create invisible background work outside the group work graph.
    let executor = group.members[1].id.clone();
    let execution_sid = crate::agent_runtime::group_session(
        &tx,
        workspace.path(),
        "group-test/mock",
        &profile,
        &gid,
        &executor,
        0,
        false,
        None,
    )
    .await
    .unwrap();
    db().unwrap()
        .update(&gid, |g| {
            g.members[1].session_id = Some(execution_sid.clone());
            let id = g.enqueue(
                "execution-root",
                &executor,
                "确认执行身份".into(),
                false,
                None,
                0,
            )?;
            let work = g.works.iter_mut().find(|w| w.id == id).unwrap();
            work.session_id = Some(execution_sid.clone());
            work.prompt_id = "execution-prompt".into();
            work.status = "running".into();
            Ok(())
        })
        .unwrap();
    remember_owner(&execution_sid, &gid, &executor);
    crate::agent_runtime::group_prompt(
        &tx,
        &execution_sid,
        "execution-prompt",
        "确认执行身份",
        &[],
    )
    .await
    .unwrap();
    let execution_call = requests
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find(|request| {
            let body = request.to_string();
            body.contains("GROUP_ROLE_MUST_SURVIVE_RESTORE") && body.contains("确认执行身份")
        })
        .cloned()
        .expect("The execution profile never reached the real Runtime model request");
    assert!(execution_call
        .to_string()
        .contains("GROUP_ROLE_MUST_SURVIVE_RESTORE"));
    let tool_names = execution_call
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|tool| tool.pointer("/function/name").and_then(Value::as_str))
        .collect::<Vec<_>>();
    assert!(
        tool_names
            .iter()
            .any(|name| name.ends_with("use_tool") || name.ends_with("group_call_member")),
        "Group members cannot reach the collaboration MCP tools: {tool_names:?}"
    );
    for tool in execution_call
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let name = tool
            .pointer("/function/name")
            .and_then(Value::as_str)
            .unwrap_or("");
        let name = name
            .rsplit("__")
            .next()
            .unwrap_or(name)
            .rsplit(':')
            .next()
            .unwrap_or(name);
        assert!(
            !matches!(name, "task" | "Agent" | "workflow" | "update_goal"),
            "Group execution exposed a second background scheduler: {name}"
        );
    }
    assert!(crate::sessions::list_workspaces().is_empty(),
        "This isolated Runtime only created group sessions; none may appear in ordinary workspace counts");
    cancel.cancel();
    tokio::time::timeout(
        std::time::Duration::from_secs(20),
        shutdown_complete.wait_for(|done| *done),
    )
    .await
    .unwrap()
    .unwrap();
    dispatcher.abort();
    server.abort();
}
