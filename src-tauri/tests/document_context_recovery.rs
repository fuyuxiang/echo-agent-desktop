//! Exercise the shipped ACP runtime against a local provider: read/checkpoint,
//! metadata-free context overflow, compact, resume, and finish the same task.
use agent_client_protocol::{self as acp, Agent};
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use echo_agent_acp::{acp_channels, AcpAgentGatewaySender, AcpClientMessage};
use echo_agent_runtime::{
    agent::{config::Config, mvp_agent::MvpAgent},
    auth::{AuthManager, EchoAgentComConfig},
};
use serde_json::{json, Value};
use std::{
    rc::Rc,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

#[derive(Clone)]
struct Provider {
    source: String,
    requests: Arc<Mutex<Vec<Value>>>,
    main_requests: Arc<AtomicUsize>,
}

fn has_document_reader(request: &Value) -> bool {
    request["tools"].as_array().is_some_and(|tools| {
        tools.iter().any(|tool| {
            tool.pointer("/function/name")
                .or_else(|| tool.get("name"))
                .and_then(Value::as_str)
                == Some("read_file")
        })
    })
}

fn is_compaction_request(request: &Value) -> bool {
    request["messages"]
        .as_array()
        .and_then(|messages| messages.last())
        .map(|message| message["content"].to_string())
        .is_some_and(|content| {
            content.contains("Your task is to produce a faithful, concise summary")
                || content.contains("<summary_request>")
        })
}

async fn infer(State(provider): State<Provider>, Json(request): Json<Value>) -> Response {
    let number = {
        let mut requests = provider.requests.lock().unwrap();
        requests.push(request.clone());
        requests.len()
    };
    let step = if has_document_reader(&request) && !is_compaction_request(&request) {
        provider.main_requests.fetch_add(1, Ordering::SeqCst) + 1
    } else {
        0
    };
    eprintln!(
        "Mock request {number}: main={step}, compaction={}, tool_choice={}",
        is_compaction_request(&request),
        request["tool_choice"]
    );
    if step == 2 {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": {
            "type": "bad_request_error", "message": "invalid params, context window exceeds limit (2013)"
        }}))).into_response();
    }
    assert!(
        number <= 12,
        "Unexpected retry or repeated document processing: request {number}, main request {step}"
    );
    let delta = match step {
        1 | 3 => {
            let tool_name = request["tools"]
                .as_array()
                .unwrap()
                .iter()
                .find_map(|tool| {
                    let name = tool
                        .pointer("/function/name")
                        .or_else(|| tool.get("name"))?
                        .as_str()?;
                    (name == "read_file").then_some(name)
                })
                .expect("shipped document reader is available");
            let mut options = json!({"mode":"read", "exhaustive":true});
            if step == 1 {
                options["checkpoint"] = json!("first row verified; preserve this finding");
            }
            json!({"role":"assistant", "tool_calls":[{"index":0,"id":format!("read-{number}"),"type":"function", "function":{
                "name":tool_name,"arguments":json!({"target_file":provider.source,"offset":if step == 1 {1} else {2},
                    "limit":if step == 1 {1} else {100},"document":options}).to_string()
            }}]})
        }
        0 => {
            let summary = format!(
                r#"<summary>
1. User request: Verify every row of the attached text document, preserving the original source and delivering only after all ten records have been checked. The task is still active and must continue in the existing session.
2. Source: {}. This file contains ten separate rows named row 1 through row 10, in order, without a trailing empty record. Use the native read_file document reader and its indexed record offsets.
3. Completed work: The first read returned only record 1 with offset=1 and limit=1. That record was checked successfully. No other record has been returned yet, so coverage must remain one of ten.
4. Saved findings: The checkpoint 'first row verified; preserve this finding' was saved against the original source. The session document journal and findings files are durable; retain that checkpoint when reading later batches.
5. Recovery: The provider rejected the next request with a metadata-free context window overflow. This summary is the context compaction response, not the final task deliverable. The user has not asked to start a different task.
6. Next step: Call read_file on the same source with offset=2, limit=100 and document.mode=read. Keep document.exhaustive=true so all remaining records are covered. Do not reread record 1 or save a duplicate checkpoint.
7. Completion: Verify the returned rows 2 through 10, then provide the final response. Reading and analysis are separate; confirm that all ten records were checked and that the existing first-row finding remains available.
</summary>"#,
                provider.source
            );
            json!({"role":"assistant","content":summary})
        }
        _ => {
            json!({"role":"assistant","content":"All ten rows verified; saved findings retained."})
        }
    };
    let tool_call = delta.get("tool_calls").is_some();
    let chunk = json!({"id":format!("response-{number}"),"object":"chat.completion.chunk","created":1,"model":"document-review",
        "choices":[{"index":0,"delta":delta,"finish_reason":null}]});
    let end = json!({"id":format!("response-{number}"),"object":"chat.completion.chunk","created":1,"model":"document-review",
        "choices":[{"index":0,"delta":{},"finish_reason":if tool_call {"tool_calls"} else {"stop"}}],
        "usage":{"prompt_tokens":1000,"completion_tokens":100,"total_tokens":1100}});
    (
        [("content-type", "text/event-stream")],
        format!("data: {chunk}\n\ndata: {end}\n\ndata: [DONE]\n\n"),
    )
        .into_response()
}

#[tokio::test(flavor = "current_thread")]
async fn metadata_free_overflow_compacts_and_resumes_saved_document_task() {
    let home = tempfile::tempdir().unwrap();
    // This binary has one test; isolate all runtime singletons before first use.
    std::env::set_var("ECHO_AGENT_HOME", home.path().join("agent"));
    std::env::set_var("GROK_HOME", home.path().join("empty-legacy"));
    std::env::set_var("ECHO_AGENT_MANAGED_CONFIG", "false");
    let work = home.path().join("work");
    std::fs::create_dir_all(&work).unwrap();
    let source = work.join("rows.txt");
    std::fs::write(
        &source,
        (1..=10)
            .map(|i| format!("row {i}"))
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let main_requests = Arc::new(AtomicUsize::new(0));
    let provider = Provider {
        source: source.to_string_lossy().into_owned(),
        requests: requests.clone(),
        main_requests: main_requests.clone(),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/v1/chat/completions", post(infer))
                .with_state(provider),
        )
        .await
        .unwrap();
    });
    let result = tokio::time::timeout(
        Duration::from_secs(45),
        tokio::task::LocalSet::new().run_until(async {
            let config = format!(
                r#"
[models]
default = "document-review"
[endpoints]
models_base_url = "http://{address}/v1"
[model.document-review]
model = "document-review"
base_url = "http://{address}/v1"
api_key = "test-only"
context_window = 200000
max_completion_tokens = 4096
agent_type = "echo-agent-build"
[features]
remote_fetch = false
managed_config = false
telemetry = "disabled"
title_refresh = false
compaction_mode = "summary"
image_gen = false
video_gen = false
"#
            );
            std::fs::create_dir_all(home.path().join("agent")).unwrap();
            std::fs::write(home.path().join("agent/config.toml"), config).unwrap();
            let raw = echo_agent_runtime::util::config::load_effective_config().unwrap();
            let mut cfg = Config::new_from_toml_cfg(&raw).unwrap();
            cfg.remote_settings = Some(Default::default());
            cfg.default_yolo_mode = true;
            let auth = Arc::new(AuthManager::new(
                &home.path().join("auth"),
                EchoAgentComConfig::default(),
            ));
            let (mut client, agent_channel) = acp_channels();
            let agent = Rc::new(
                MvpAgent::new(
                    AcpAgentGatewaySender::new(agent_channel.tx),
                    &cfg,
                    auth,
                    None,
                )
                .unwrap(),
            );
            let updates = Arc::new(Mutex::new(Vec::new()));
            let captured = updates.clone();
            let drain = tokio::task::spawn_local(async move {
                while let Some(message) = client.rx.recv().await {
                    match message {
                        AcpClientMessage::SessionNotification(args) => {
                            captured
                                .lock()
                                .unwrap()
                                .push(serde_json::to_value(&args.request.update).unwrap());
                            let _ = args.response_tx.send(Ok(()));
                        }
                        AcpClientMessage::ExtNotification(args) => {
                            captured
                                .lock()
                                .unwrap()
                                .push(serde_json::from_str(args.request.params.get()).unwrap());
                            let _ = args.response_tx.send(Ok(()));
                        }
                        other => panic!("Unexpected client capability request: {other:?}"),
                    }
                }
            });
            agent
                .initialize(
                    acp::InitializeRequest::new(acp::ProtocolVersion::V1)
                        .client_capabilities(acp::ClientCapabilities::new()),
                )
                .await
                .unwrap();
            let session = agent
                .new_session(
                    acp::NewSessionRequest::new(work.clone()).meta(Some(
                        serde_json::from_value::<acp::Meta>(json!({"modelId":"document-review"}))
                            .unwrap(),
                    )),
                )
                .await
                .unwrap();
            let content = acp::TextContent::new("Read and verify every row in the attached file.")
                .meta(
                    serde_json::from_value::<acp::Meta>(
                        json!({"displayText":"Verify every row", "echoAgentAttachments":[source]}),
                    )
                    .unwrap(),
                );
            let prompt = agent
                .prompt(acp::PromptRequest::new(
                    session.session_id,
                    vec![acp::ContentBlock::Text(content)],
                ))
                .await;
            assert!(prompt.is_ok(), "Recovery failed: {prompt:?}");
            agent
                .flush_all_sessions_checked(Duration::from_secs(5))
                .await
                .unwrap();
            let notifications = updates.lock().unwrap();
            let serialized = serde_json::to_string(&*notifications).unwrap();
            assert!(
                serialized.contains("auto_compact") || serialized.contains("autoCompact"),
                "Compaction notifications missing: {serialized}"
            );
            let progress: Vec<_> = notifications
                .iter()
                .filter_map(|update| update.pointer("/rawOutput/FileContent/document_progress"))
                .filter(|progress| progress["source"] == "rows.txt")
                .collect();
            assert_eq!(
                progress.len(),
                2,
                "Read the first batch once and the remaining batch once"
            );
            assert!(
                progress
                    .iter()
                    .any(|p| p["readRecords"] == 1 && p["checkpointCount"] == 1),
                "First checkpoint missing: {serialized}"
            );
            assert!(
                progress.iter().any(|p| p["readRecords"] == 10
                    && p["complete"] == true
                    && p["checkpointCount"] == 1),
                "Restored document progress missing: {serialized}"
            );
            let findings = progress.last().unwrap()["checkpointPath"].as_str().unwrap();
            let journal_path = std::path::Path::new(findings)
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("task.json");
            let journal: Value =
                serde_json::from_slice(&std::fs::read(journal_path).unwrap()).unwrap();
            assert_eq!(
                journal["completed"], true,
                "Only a successfully completed turn closes its document scope"
            );
            drain.abort();
        }),
    )
    .await;
    server.abort();
    result.expect("ACP recovery timed out");
    let bodies = requests.lock().unwrap();
    // Title and session maintenance can sample alongside the actual task.
    // Native document updates above, rather than total HTTP request count,
    // prove that recovery did not repeat either reading batch.
    assert!(main_requests.load(Ordering::SeqCst) >= 4);
    assert!(
        bodies.iter().any(is_compaction_request),
        "Expected an actual compaction request"
    );
}
