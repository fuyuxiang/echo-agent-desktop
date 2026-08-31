//! Local, authenticated MCP bridge for the remote organization-memory API.
//!
//! EchoAgent connects to this server as an MCP client. The bridge keeps the
//! remote access token inside Rust and delegates every authorization decision
//! to echo-agent-server. A random per-process header prevents unrelated local
//! processes from borrowing the desktop user's organization session.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Router,
};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::collections::VecDeque;
use std::io::Read;
use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use uuid::Uuid;

pub const MCP_SERVER_NAME: &str = "echoagent_organization_memory";
pub const AUTH_HEADER: &str = "x-echo-org-mcp-token";
const MCP_PREFERRED_PORT: u16 = 14751;
const MCP_PORT_SCAN: u16 = 20;

static BOUND_PORT: OnceLock<u16> = OnceLock::new();
static PROCESS_TOKEN: OnceLock<String> = OnceLock::new();
static PERSISTED: Mutex<bool> = Mutex::new(false);

#[derive(Clone)]
struct ServerState {
    token: String,
}

pub fn serve() {
    static SERVED: OnceLock<()> = OnceLock::new();
    if SERVED.set(()).is_err() {
        return;
    }
    let Some(listener) = bind_with_retry() else {
        tracing::error!("organization MCP server: no free loopback port");
        return;
    };
    let port = listener
        .local_addr()
        .map(|addr| addr.port())
        .unwrap_or(MCP_PREFERRED_PORT);
    let token = Uuid::new_v4().to_string();
    let _ = BOUND_PORT.set(port);
    let _ = PROCESS_TOKEN.set(token.clone());
    tracing::info!(port, "organization MCP server listening");

    tauri::async_runtime::spawn(async move {
        if let Err(error) = listener.set_nonblocking(true) {
            tracing::error!(%error, "organization MCP listener setup failed");
            return;
        }
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(error) => {
                tracing::error!(%error, "organization MCP listener conversion failed");
                return;
            }
        };
        let app = Router::new()
            .route("/mcp", post(handle_post))
            .route("/mcp", get(method_not_allowed))
            .route("/mcp", delete(method_not_allowed))
            .with_state(ServerState { token });
        if let Err(error) = axum::serve(listener, app).await {
            tracing::error!(%error, "organization MCP server stopped");
        }
    });
}

fn bind_with_retry() -> Option<TcpListener> {
    for offset in 0..=MCP_PORT_SCAN {
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, MCP_PREFERRED_PORT + offset));
        if let Ok(listener) = TcpListener::bind(address) {
            return Some(listener);
        }
    }
    None
}

pub fn server_config() -> Option<(String, String)> {
    Some((
        format!("http://127.0.0.1:{}/mcp", BOUND_PORT.get()?),
        PROCESS_TOKEN.get()?.clone(),
    ))
}

async fn method_not_allowed() -> Response {
    StatusCode::METHOD_NOT_ALLOWED.into_response()
}

#[derive(Deserialize)]
struct JsonRpcRequest {
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

async fn handle_post(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let authorized = headers
        .get(AUTH_HEADER)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == state.token);
    if !authorized {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let request: JsonRpcRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(error) => return rpc_error(Value::Null, -32700, format!("parse error: {error}")),
    };
    let Some(id) = request.id else {
        return StatusCode::ACCEPTED.into_response();
    };
    let result = match request.method.as_str() {
        "initialize" => initialize_result(&request.params),
        "ping" => json!({}),
        "tools/list" => tools_list_result(),
        "tools/call" => match tools_call(&request.params).await {
            Ok(result) => result,
            Err(message) => tool_result(Value::String(message), true),
        },
        other => return rpc_error(id, -32601, format!("method not found: {other}")),
    };
    rpc_result(id, result)
}

fn initialize_result(params: &Value) -> Value {
    let protocol = params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or("2025-03-26");
    json!({
        "protocolVersion": protocol,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": MCP_SERVER_NAME, "version": env!("CARGO_PKG_VERSION") }
    })
}

fn tools_list_result() -> Value {
    json!({ "tools": [
        {
            "name": "knowledge_ask",
            "description": "Answer a question from the signed-in user's authorized personal, team, and organization knowledge. Returns grounded citations; use this for synthesized answers.",
            "inputSchema": {
                "type": "object", "additionalProperties": false,
                "properties": {
                    "question": { "type": "string", "minLength": 1 },
                    "mode": { "type": "string", "enum": ["auto", "fast", "deep"], "default": "auto" },
                    "scope_kinds": { "type": "array", "items": { "type": "string", "enum": ["personal", "team", "org"] } },
                    "scope_ids": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["question"]
            }
        },
        {
            "name": "knowledge_search",
            "description": "Search authorized organization knowledge and return evidence chunks. Use when you need raw passages or want to inspect sources before answering.",
            "inputSchema": {
                "type": "object", "additionalProperties": false,
                "properties": {
                    "query": { "type": "string", "minLength": 1 },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 20, "default": 8 },
                    "multi_hop": { "type": "boolean", "default": false },
                    "scope_kinds": { "type": "array", "items": { "type": "string", "enum": ["personal", "team", "org"] } },
                    "scope_ids": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["query"]
            }
        },
        {
            "name": "knowledge_fetch_document",
            "description": "Fetch an authorized document or its parsed text by document id returned in a citation.",
            "inputSchema": {
                "type": "object", "additionalProperties": false,
                "properties": { "doc_id": { "type": "string", "minLength": 1 } },
                "required": ["doc_id"]
            }
        },
        {
            "name": "knowledge_fetch_doc",
            "description": "Fetch authorized parsed document text by id. This is the canonical alias used by the organization-memory contract.",
            "inputSchema": {
                "type": "object", "additionalProperties": false,
                "properties": {
                    "doc_id": { "type": "string", "minLength": 1 },
                    "page": { "type": "integer", "minimum": 1 }
                },
                "required": ["doc_id"]
            }
        },
        {
            "name": "knowledge_list_documents",
            "description": "List documents visible to the signed-in user, optionally limited to a scope or title query.",
            "inputSchema": {
                "type": "object", "additionalProperties": false,
                "properties": {
                    "scope_id": { "type": "string" },
                    "query": { "type": "string" }
                }
            }
        },
        {
            "name": "knowledge_list_docs",
            "description": "List documents visible to the signed-in user. Canonical alias of knowledge_list_documents.",
            "inputSchema": {
                "type": "object", "additionalProperties": false,
                "properties": {
                    "scope_id": { "type": "string" },
                    "query": { "type": "string" }
                }
            }
        },
        {
            "name": "knowledge_who_knows",
            "description": "Find maintainers of authorized documents related to a topic.",
            "inputSchema": {
                "type": "object", "additionalProperties": false,
                "properties": { "topic": { "type": "string", "minLength": 1 } },
                "required": ["topic"]
            }
        },
        {
            "name": "knowledge_submit",
            "description": "Submit a candidate memory to an authorized team or organization review queue. It never publishes directly.",
            "inputSchema": {
                "type": "object", "additionalProperties": false,
                "properties": {
                    "kind": { "type": "string", "enum": ["fact", "decision", "convention", "pitfall", "howto"] },
                    "content": { "type": "string", "minLength": 1, "maxLength": 2000 },
                    "rationale": { "type": "string", "maxLength": 2000 },
                    "target_scope": { "type": "string", "minLength": 1 }
                },
                "required": ["kind", "content", "target_scope"]
            }
        },
        {
            "name": "local_knowledge_search",
            "description": "Search user-configured on-device knowledge folders. Content remains local and is available only when signed enterprise policy allows local knowledge.",
            "inputSchema": {
                "type": "object", "additionalProperties": false,
                "properties": {
                    "query": { "type": "string", "minLength": 1 },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 20, "default": 8 }
                },
                "required": ["query"]
            }
        },
        {
            "name": "local_knowledge_fetch",
            "description": "Fetch a local knowledge file returned by local_knowledge_search. Paths outside configured roots and symbolic-link escapes are rejected.",
            "inputSchema": {
                "type": "object", "additionalProperties": false,
                "properties": { "path": { "type": "string", "minLength": 1 } },
                "required": ["path"]
            }
        }
    ] })
}

async fn tools_call(params: &Value) -> Result<Value, String> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or("tool name is required")?;
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let data = match name {
        "knowledge_ask" => {
            let question = required_string(&arguments, "question")?;
            let mut input = json!({
                "question": question,
                "mode": arguments.get("mode").and_then(Value::as_str).unwrap_or("auto")
            });
            copy_non_null(&arguments, "scope_kinds", &mut input, "scopeKinds");
            copy_non_null(&arguments, "scope_ids", &mut input, "scopeIds");
            crate::org::mcp_ask(input).await?
        }
        "knowledge_search" => {
            let query = required_string(&arguments, "query")?;
            let mut input = json!({
                "query": query,
                "limit": arguments.get("limit").and_then(Value::as_u64).unwrap_or(8),
                "multi_hop": arguments.get("multi_hop").and_then(Value::as_bool).unwrap_or(false)
            });
            copy_non_null(&arguments, "scope_ids", &mut input, "scope_ids");
            if let Some(kinds) = arguments
                .get("scope_kinds")
                .filter(|value| !value.is_null())
            {
                input["filters"] = json!({ "scope_kinds": kinds });
            }
            crate::org::mcp_json(Method::POST, "/api/v1/retrieve", Some(input)).await?
        }
        "knowledge_fetch_document" | "knowledge_fetch_doc" => {
            let doc_id = required_string(&arguments, "doc_id")?;
            let mut input = json!({ "docId": doc_id });
            copy_non_null(&arguments, "page", &mut input, "page");
            crate::org::mcp_json(Method::POST, "/api/v1/docs/fetch", Some(input)).await?
        }
        "knowledge_list_documents" | "knowledge_list_docs" => {
            let mut url = url::Url::parse("http://local/api/v1/docs").expect("static URL");
            {
                let mut query = url.query_pairs_mut();
                if let Some(scope_id) = arguments.get("scope_id").and_then(Value::as_str) {
                    query.append_pair("scopeId", scope_id);
                }
                if let Some(text) = arguments.get("query").and_then(Value::as_str) {
                    query.append_pair("q", text);
                }
            }
            let path = format!(
                "{}{}",
                url.path(),
                url.query().map(|q| format!("?{q}")).unwrap_or_default()
            );
            crate::org::mcp_json(Method::GET, &path, None).await?
        }
        "knowledge_who_knows" => {
            let topic = required_string(&arguments, "topic")?;
            let result = crate::org::mcp_json(
                Method::POST,
                "/api/v1/retrieve",
                Some(json!({ "query": topic, "limit": 20, "multi_hop": false })),
            )
            .await?;
            let mut owners: HashMap<String, (String, usize, Vec<String>)> = HashMap::new();
            for chunk in result
                .get("chunks")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let Some(owner) = chunk.get("owner") else {
                    continue;
                };
                let Some(id) = owner.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let name = owner
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or(id)
                    .to_string();
                let title = chunk
                    .get("docTitle")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let entry = owners
                    .entry(id.to_string())
                    .or_insert((name, 0, Vec::new()));
                entry.1 += 1;
                if !title.is_empty() && !entry.2.contains(&title) {
                    entry.2.push(title);
                }
            }
            let mut people = owners
                .into_iter()
                .map(|(id, (name, hits, titles))| json!({
                    "userId": id,
                    "displayName": name,
                    "hits": hits,
                    "reason": format!("维护相关文档：{}", titles.into_iter().take(2).collect::<Vec<_>>().join("、"))
                }))
                .collect::<Vec<_>>();
            people.sort_by_key(|person| {
                std::cmp::Reverse(person.get("hits").and_then(Value::as_u64).unwrap_or(0))
            });
            json!({ "people": people.into_iter().take(5).collect::<Vec<_>>() })
        }
        "knowledge_submit" => {
            let kind = required_string(&arguments, "kind")?;
            let content = required_string(&arguments, "content")?;
            let target_scope = required_string(&arguments, "target_scope")?;
            let mut payload = json!({ "kind": kind, "content": content });
            copy_non_null(&arguments, "rationale", &mut payload, "rationale");
            crate::org::mcp_json(
                Method::POST,
                "/api/v1/promotions",
                Some(json!({
                    "payloadType": "memory",
                    "payload": payload,
                    "source": "manual",
                    "targetScope": target_scope
                })),
            )
            .await?
        }
        "local_knowledge_search" => {
            if !crate::org::local_knowledge_allowed().await {
                return Err("signed organization policy disables local knowledge".into());
            }
            let query = required_string(&arguments, "query")?;
            let limit = arguments.get("limit").and_then(Value::as_u64).unwrap_or(8) as usize;
            json!({ "items": search_local_knowledge(query, limit)? })
        }
        "local_knowledge_fetch" => {
            if !crate::org::local_knowledge_allowed().await {
                return Err("signed organization policy disables local knowledge".into());
            }
            let path = required_string(&arguments, "path")?;
            let canonical = authorized_local_path(path)?;
            let text = read_local_knowledge(&canonical)?;
            json!({ "path": canonical, "text": text })
        }
        _ => return Err(format!("unknown organization-memory tool: {name}")),
    };
    Ok(tool_result(data, false))
}

#[derive(Deserialize)]
struct LocalSource {
    root: String,
    #[serde(default = "enabled_by_default")]
    enabled: bool,
}

fn enabled_by_default() -> bool {
    true
}

fn local_roots() -> Vec<PathBuf> {
    let Ok(bytes) = std::fs::read(crate::org::local_kb_sources_path()) else {
        return Vec::new();
    };
    let Ok(sources) = serde_json::from_slice::<Vec<LocalSource>>(&bytes) else {
        return Vec::new();
    };
    sources
        .into_iter()
        .filter(|source| source.enabled)
        .filter_map(|source| std::fs::canonicalize(source.root).ok())
        .filter(|root| root.is_dir())
        .take(50)
        .collect()
}

fn supported_local_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("md" | "markdown" | "mdx" | "txt" | "rst" | "log" | "docx" | "pptx" | "xlsx")
    )
}

fn local_files() -> Vec<PathBuf> {
    let mut out = Vec::new();
    for root in local_roots() {
        let mut queue = VecDeque::from([(root, 0usize)]);
        while let Some((directory, depth)) = queue.pop_front() {
            if depth > 5 || out.len() >= 500 {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(directory) else {
                continue;
            };
            for entry in entries.flatten() {
                let Ok(kind) = entry.file_type() else {
                    continue;
                };
                if kind.is_symlink() {
                    continue;
                }
                let path = entry.path();
                if kind.is_dir() && depth < 5 {
                    queue.push_back((path, depth + 1));
                } else if kind.is_file() && supported_local_file(&path) {
                    out.push(path);
                    if out.len() >= 500 {
                        break;
                    }
                }
            }
        }
    }
    out
}

fn xml_text(xml: &str) -> String {
    let mut reader = quick_xml::Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut out = Vec::new();
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Text(text)) => {
                if let Ok(value) = text.decode() {
                    let value = value.trim();
                    if !value.is_empty() {
                        out.push(value.to_string())
                    }
                }
            }
            Ok(quick_xml::events::Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    out.join(" ")
}

fn read_local_knowledge(path: &Path) -> Result<String, String> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| format!("read local knowledge metadata: {error}"))?;
    if metadata.len() > 5 * 1024 * 1024 {
        return Err("local knowledge file exceeds 5MB".into());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(extension.as_str(), "docx" | "pptx" | "xlsx") {
        let file = std::fs::File::open(path)
            .map_err(|error| format!("open local Office file: {error}"))?;
        let mut archive = zip::ZipArchive::new(file)
            .map_err(|error| format!("open local Office ZIP: {error}"))?;
        let mut parts = Vec::new();
        for index in 0..archive.len().min(500) {
            let mut entry = archive
                .by_index(index)
                .map_err(|error| format!("read local Office entry: {error}"))?;
            let name = entry.name().to_string();
            let selected = match extension.as_str() {
                "docx" => name == "word/document.xml",
                "pptx" => name.starts_with("ppt/slides/slide") && name.ends_with(".xml"),
                "xlsx" => {
                    (name == "xl/sharedStrings.xml" || name.starts_with("xl/worksheets/sheet"))
                        && name.ends_with(".xml")
                }
                _ => false,
            };
            if !selected || entry.size() > 2 * 1024 * 1024 {
                continue;
            }
            let mut xml = String::new();
            if entry.read_to_string(&mut xml).is_ok() {
                parts.push(xml_text(&xml))
            }
        }
        return Ok(parts.join("\n"));
    }
    std::fs::read_to_string(path).map_err(|error| format!("read local knowledge: {error}"))
}

fn authorized_local_path(raw: &str) -> Result<PathBuf, String> {
    let path = std::fs::canonicalize(raw).map_err(|_| "local knowledge file does not exist")?;
    if !path.is_file() || !supported_local_file(&path) {
        return Err("unsupported local knowledge file".into());
    }
    if !local_roots().iter().any(|root| path.starts_with(root)) {
        return Err("local knowledge path is outside configured roots".into());
    }
    Ok(path)
}

fn search_local_knowledge(query: &str, limit: usize) -> Result<Vec<Value>, String> {
    let query_lower = query.to_lowercase();
    let mut items = Vec::new();
    for path in local_files() {
        let title = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        let title_hit = title.to_lowercase().contains(&query_lower);
        let text = read_local_knowledge(&path).unwrap_or_default();
        let lower = text.to_lowercase();
        let Some(position) = lower.find(&query_lower).or_else(|| title_hit.then_some(0)) else {
            continue;
        };
        let start = position.saturating_sub(80);
        let snippet = text
            .get(start..text.len().min(start + 320))
            .unwrap_or(&text)
            .to_string();
        items.push(json!({
            "path": path,
            "title": title,
            "snippet": snippet,
            "source": "local",
            "openUrl": format!("file://{}", path.to_string_lossy())
        }));
        if items.len() >= limit.min(20) {
            break;
        }
    }
    Ok(items)
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{key} is required"))
}

fn copy_non_null(source: &Value, source_key: &str, target: &mut Value, target_key: &str) {
    if let Some(value) = source.get(source_key).filter(|value| !value.is_null()) {
        target[target_key] = value.clone();
    }
}

fn tool_result(value: Value, is_error: bool) -> Value {
    let text = if let Some(text) = value.as_str() {
        text.to_string()
    } else {
        serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string())
    };
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

fn rpc_result(id: Value, result: Value) -> Response {
    (
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string(),
    )
        .into_response()
}

fn rpc_error(id: Value, code: i64, message: String) -> Response {
    (
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
            .to_string(),
    )
        .into_response()
}

/// Persist the bridge through EchoAgent's own extension API so restored
/// sessions reconnect after an application restart or loopback port change.
pub fn persist_registration(tx: &xai_acp_lib::AcpAgentTx, session_id: &str) {
    {
        let mut done = PERSISTED.lock().unwrap();
        if *done {
            return;
        }
        *done = true;
    }
    let Some((url, token)) = server_config() else {
        *PERSISTED.lock().unwrap() = false;
        return;
    };
    let tx = tx.clone();
    let session_id = session_id.to_string();
    tokio::spawn(async move {
        let payload = json!({
            "session_id": session_id,
            "server_name": MCP_SERVER_NAME,
            "url": url,
            "headers": { AUTH_HEADER: token },
            "enabled": true
        });
        match crate::ext::call_ext_value(
            &tx,
            "echo.agent/mcp/upsert",
            crate::ext::raw_params(&payload),
        )
        .await
        {
            Ok(_) => tracing::info!("organization MCP server persisted to config.toml"),
            Err(error) => {
                tracing::warn!(?error, "organization MCP persistence failed");
                *PERSISTED.lock().unwrap() = false;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn requires_process_token_and_lists_tools() {
        let std_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = std_listener.local_addr().unwrap();
        std_listener.set_nonblocking(true).unwrap();
        let listener = tokio::net::TcpListener::from_std(std_listener).unwrap();
        tokio::spawn(async move {
            let app = Router::new()
                .route("/mcp", post(handle_post))
                .with_state(ServerState {
                    token: "test-secret".into(),
                });
            let _ = axum::serve(listener, app).await;
        });
        let request = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });
        let client = reqwest::Client::new();
        let url = format!("http://{address}/mcp");
        assert_eq!(
            client
                .post(&url)
                .json(&request)
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        let response: Value = client
            .post(&url)
            .header(AUTH_HEADER, "test-secret")
            .json(&request)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(response["result"]["tools"].as_array().unwrap().len(), 10);
    }
}
