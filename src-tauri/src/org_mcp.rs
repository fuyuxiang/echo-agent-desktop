//! Local, authenticated MCP bridge for the remote organization-memory API.
//!
//! EchoAgent connects to this server as an MCP client. The bridge keeps the
//! remote access token inside Rust and delegates every authorization decision
//! to echo-agent-server. A random per-process header prevents unrelated local
//! processes from borrowing the desktop user's organization session.

use axum::{
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Router,
};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::collections::VecDeque;
use std::io::{Cursor, Read};
use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use uuid::Uuid;

pub const MCP_SERVER_NAME: &str = "echoagent_organization_memory";
pub const AUTH_HEADER: &str = "x-echo-org-mcp-token";
const MAX_MCP_BODY_BYTES: usize = 256 * 1024;
const MAX_TOOL_TEXT_CHARS: usize = 8_192;
const MAX_IDENTIFIER_CHARS: usize = 256;
const MAX_SCOPE_ITEMS: usize = 64;
const MAX_LOCAL_SOURCES_BYTES: u64 = 1024 * 1024;
const MAX_LOCAL_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_OFFICE_ENTRY_BYTES: u64 = 2 * 1024 * 1024;
const MAX_OFFICE_XML_BYTES: u64 = 8 * 1024 * 1024;
const MAX_LOCAL_SCAN_ENTRIES: usize = 10_000;
const MAX_LOCAL_FILES: usize = 500;

static BOUND_PORT: OnceLock<u16> = OnceLock::new();
static PROCESS_TOKEN: OnceLock<String> = OnceLock::new();
static PERSISTED: Mutex<bool> = Mutex::new(false);

#[derive(Clone)]
struct ServerState {
    token: String,
    expected_host: String,
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
    let address = match listener.local_addr() {
        Ok(address) => address,
        Err(error) => {
            tracing::error!(%error, "organization MCP server: unable to read bound address");
            return;
        }
    };
    let port = address.port();
    let token = format!("{}{}", Uuid::now_v7().simple(), Uuid::now_v7().simple());
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
            .layer(DefaultBodyLimit::max(MAX_MCP_BODY_BYTES))
            .with_state(ServerState {
                token,
                expected_host: address.to_string(),
            });
        if let Err(error) = axum::serve(listener, app).await {
            tracing::error!(%error, "organization MCP server stopped");
        }
    });
}

fn bind_with_retry() -> Option<TcpListener> {
    TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).ok()
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
    if let Err(status) = validate_request_headers(&headers, &state) {
        return status.into_response();
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

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

fn validate_request_headers(headers: &HeaderMap, state: &ServerState) -> Result<(), StatusCode> {
    let token = headers
        .get(AUTH_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if !constant_time_eq(token.as_bytes(), state.token.as_bytes()) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .ok_or(StatusCode::BAD_REQUEST)?;
    if !host.eq_ignore_ascii_case(&state.expected_host) {
        return Err(StatusCode::MISDIRECTED_REQUEST);
    }
    if headers.contains_key(header::ORIGIN) {
        return Err(StatusCode::FORBIDDEN);
    }
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .unwrap_or_default();
    if !content_type.eq_ignore_ascii_case("application/json") {
        return Err(StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }
    Ok(())
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
    let name = required_string_bounded(params, "name", 128)?;
    let arguments = match params.get("arguments") {
        None | Some(Value::Null) => json!({}),
        Some(value) if value.is_object() => value.clone(),
        Some(_) => return Err("tool arguments must be an object".into()),
    };
    let data = match name {
        "knowledge_ask" => {
            let question = required_string_bounded(&arguments, "question", MAX_TOOL_TEXT_CHARS)?;
            let mode = optional_string_bounded(&arguments, "mode", 16)?.unwrap_or("auto");
            if !matches!(mode, "auto" | "fast" | "deep") {
                return Err("mode must be auto, fast, or deep".into());
            }
            let mut input = json!({
                "question": question,
                "mode": mode
            });
            if let Some(kinds) = validated_string_array(
                &arguments,
                "scope_kinds",
                MAX_SCOPE_ITEMS,
                16,
                Some(&["personal", "team", "org"]),
            )? {
                input["scopeKinds"] = kinds.clone();
            }
            if let Some(ids) = validated_string_array(
                &arguments,
                "scope_ids",
                MAX_SCOPE_ITEMS,
                MAX_IDENTIFIER_CHARS,
                None,
            )? {
                input["scopeIds"] = ids.clone();
            }
            crate::org::mcp_ask(input).await?
        }
        "knowledge_search" => {
            let query = required_string_bounded(&arguments, "query", MAX_TOOL_TEXT_CHARS)?;
            let limit = validated_limit(&arguments)?;
            let mut input = json!({
                "query": query,
                "limit": limit,
                "multi_hop": arguments.get("multi_hop").and_then(Value::as_bool).unwrap_or(false)
            });
            if arguments
                .get("multi_hop")
                .is_some_and(|value| !value.is_boolean())
            {
                return Err("multi_hop must be a boolean".into());
            }
            if let Some(ids) = validated_string_array(
                &arguments,
                "scope_ids",
                MAX_SCOPE_ITEMS,
                MAX_IDENTIFIER_CHARS,
                None,
            )? {
                input["scope_ids"] = ids.clone();
            }
            if let Some(kinds) = validated_string_array(
                &arguments,
                "scope_kinds",
                MAX_SCOPE_ITEMS,
                16,
                Some(&["personal", "team", "org"]),
            )? {
                input["filters"] = json!({ "scope_kinds": kinds });
            }
            crate::org::mcp_json(Method::POST, "/api/v1/retrieve", Some(input)).await?
        }
        "knowledge_fetch_document" | "knowledge_fetch_doc" => {
            let doc_id = required_string_bounded(&arguments, "doc_id", MAX_IDENTIFIER_CHARS)?;
            let mut input = json!({ "docId": doc_id });
            if let Some(page) = validated_page(&arguments)? {
                input["page"] = json!(page);
            }
            crate::org::mcp_json(Method::POST, "/api/v1/docs/fetch", Some(input)).await?
        }
        "knowledge_list_documents" | "knowledge_list_docs" => {
            let mut url = url::Url::parse("http://local/api/v1/docs").expect("static URL");
            {
                let mut query = url.query_pairs_mut();
                if let Some(scope_id) =
                    optional_string_bounded(&arguments, "scope_id", MAX_IDENTIFIER_CHARS)?
                {
                    query.append_pair("scopeId", scope_id);
                }
                if let Some(text) =
                    optional_string_bounded(&arguments, "query", MAX_TOOL_TEXT_CHARS)?
                {
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
            let topic = required_string_bounded(&arguments, "topic", MAX_TOOL_TEXT_CHARS)?;
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
            let kind = required_string_bounded(&arguments, "kind", 32)?;
            if !matches!(
                kind,
                "fact" | "decision" | "convention" | "pitfall" | "howto"
            ) {
                return Err("unsupported knowledge kind".into());
            }
            let content = required_string_bounded(&arguments, "content", 2_000)?;
            let target_scope =
                required_string_bounded(&arguments, "target_scope", MAX_IDENTIFIER_CHARS)?;
            let mut payload = json!({ "kind": kind, "content": content });
            if let Some(rationale) = optional_string_bounded(&arguments, "rationale", 2_000)? {
                payload["rationale"] = json!(rationale);
            }
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
            let query = required_string_bounded(&arguments, "query", MAX_TOOL_TEXT_CHARS)?;
            let limit = validated_limit(&arguments)? as usize;
            json!({ "items": search_local_knowledge(query, limit)? })
        }
        "local_knowledge_fetch" => {
            if !crate::org::local_knowledge_allowed().await {
                return Err("signed organization policy disables local knowledge".into());
            }
            let path = required_string_bounded(&arguments, "path", 4_096)?;
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

fn local_roots() -> Result<Vec<PathBuf>, String> {
    let path = crate::org::local_kb_sources_path();
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("read local knowledge sources metadata: {error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("local knowledge sources config must be a regular file".into());
    }
    if metadata.len() > MAX_LOCAL_SOURCES_BYTES {
        return Err("local knowledge sources config exceeds 1MB".into());
    }
    let bytes = crate::shell_fs::read_regular_file_bounded(&path, MAX_LOCAL_SOURCES_BYTES)
        .map_err(|error| format!("read local knowledge sources: {error}"))?;
    let sources = serde_json::from_slice::<Vec<LocalSource>>(&bytes)
        .map_err(|error| format!("invalid local knowledge sources config: {error}"))?;
    if sources.len() > 50 {
        return Err("local knowledge sources config contains more than 50 roots".into());
    }
    let mut roots = Vec::new();
    for source in sources.into_iter().filter(|source| source.enabled) {
        if source.root.chars().count() > 4_096 || source.root.contains('\0') {
            return Err("local knowledge root path is invalid".into());
        }
        let Ok(root) = std::fs::canonicalize(source.root) else {
            continue;
        };
        if root.is_dir() && !roots.contains(&root) {
            roots.push(root);
        }
    }
    Ok(roots)
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

fn local_files() -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    let mut scanned_entries = 0usize;
    for root in local_roots()? {
        let mut queue = VecDeque::from([(root.clone(), 0usize)]);
        while let Some((directory, depth)) = queue.pop_front() {
            if depth > 5
                || out.len() >= MAX_LOCAL_FILES
                || scanned_entries >= MAX_LOCAL_SCAN_ENTRIES
            {
                continue;
            }
            let Ok(canonical_directory) = std::fs::canonicalize(&directory) else {
                continue;
            };
            if !canonical_directory.starts_with(&root) {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(canonical_directory) else {
                continue;
            };
            for entry in entries.flatten() {
                scanned_entries = scanned_entries.saturating_add(1);
                if scanned_entries > MAX_LOCAL_SCAN_ENTRIES {
                    break;
                }
                let path = entry.path();
                let Ok(metadata) = std::fs::symlink_metadata(&path) else {
                    continue;
                };
                if metadata.file_type().is_symlink() {
                    continue;
                }
                let Ok(canonical) = std::fs::canonicalize(&path) else {
                    continue;
                };
                if !canonical.starts_with(&root) {
                    continue;
                }
                if metadata.is_dir() && depth < 5 {
                    queue.push_back((canonical, depth + 1));
                } else if metadata.is_file() && supported_local_file(&canonical) {
                    out.push(canonical);
                    if out.len() >= MAX_LOCAL_FILES {
                        break;
                    }
                }
            }
        }
        if out.len() >= MAX_LOCAL_FILES || scanned_entries >= MAX_LOCAL_SCAN_ENTRIES {
            break;
        }
    }
    Ok(out)
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
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("read local knowledge metadata: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("local knowledge path must be a regular file".into());
    }
    if metadata.len() > MAX_LOCAL_FILE_BYTES {
        return Err("local knowledge file exceeds 5MB".into());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let bytes = crate::shell_fs::read_regular_file_bounded(path, MAX_LOCAL_FILE_BYTES)
        .map_err(|error| format!("read local knowledge: {error}"))?;
    if matches!(extension.as_str(), "docx" | "pptx" | "xlsx") {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
            .map_err(|error| format!("open local Office ZIP: {error}"))?;
        let mut parts = Vec::new();
        let mut total_xml_bytes = 0_u64;
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
            if !selected {
                continue;
            }
            if entry.size() > MAX_OFFICE_ENTRY_BYTES {
                return Err("local Office XML entry exceeds 2MB".into());
            }
            let remaining = MAX_OFFICE_XML_BYTES.saturating_sub(total_xml_bytes);
            if remaining == 0 || entry.size() > remaining {
                return Err("local Office XML content exceeds 8MB".into());
            }
            let read_limit = remaining.min(MAX_OFFICE_ENTRY_BYTES);
            let mut bytes = Vec::new();
            (&mut entry)
                .take(read_limit + 1)
                .read_to_end(&mut bytes)
                .map_err(|error| format!("read local Office XML: {error}"))?;
            if bytes.len() as u64 > read_limit {
                return Err("local Office XML content exceeds its size limit".into());
            }
            total_xml_bytes = total_xml_bytes.saturating_add(bytes.len() as u64);
            let xml = String::from_utf8(bytes)
                .map_err(|_| "local Office XML is not valid UTF-8".to_string())?;
            parts.push(xml_text(&xml));
        }
        return Ok(parts.join("\n"));
    }
    String::from_utf8(bytes).map_err(|_| "local knowledge file is not valid UTF-8".into())
}

fn authorized_local_path(raw: &str) -> Result<PathBuf, String> {
    let path = std::fs::canonicalize(raw).map_err(|_| "local knowledge file does not exist")?;
    if !path.is_file() || !supported_local_file(&path) {
        return Err("unsupported local knowledge file".into());
    }
    if !local_roots()?.iter().any(|root| path.starts_with(root)) {
        return Err("local knowledge path is outside configured roots".into());
    }
    Ok(path)
}

fn search_local_knowledge(query: &str, limit: usize) -> Result<Vec<Value>, String> {
    let query_lower = query.to_lowercase();
    let mut items = Vec::new();
    for path in local_files()? {
        let title = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        let title_hit = title.to_lowercase().contains(&query_lower);
        let Ok(text) = read_local_knowledge(&path) else {
            continue;
        };
        let lower = text.to_lowercase();
        let Some(position) = lower.find(&query_lower).or_else(|| title_hit.then_some(0)) else {
            continue;
        };
        let approximate_character = lower
            .get(..position)
            .map(|prefix| prefix.chars().count())
            .unwrap_or_default();
        let start_character = approximate_character.saturating_sub(80);
        let snippet = text
            .chars()
            .skip(start_character)
            .take(320)
            .collect::<String>();
        let open_url = url::Url::from_file_path(&path)
            .ok()
            .map(|url| url.to_string());
        items.push(json!({
            "path": path,
            "title": title,
            "snippet": snippet,
            "source": "local",
            "openUrl": open_url
        }));
        if items.len() >= limit.min(20) {
            break;
        }
    }
    Ok(items)
}

fn required_string_bounded<'a>(
    value: &'a Value,
    key: &str,
    max_chars: usize,
) -> Result<&'a str, String> {
    let text = value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| format!("{key} is required"))?;
    if text.chars().count() > max_chars || has_disallowed_control(text) {
        return Err(format!(
            "{key} must contain at most {max_chars} non-control characters"
        ));
    }
    Ok(text)
}

fn optional_string_bounded<'a>(
    value: &'a Value,
    key: &str,
    max_chars: usize,
) -> Result<Option<&'a str>, String> {
    let Some(raw) = value.get(key) else {
        return Ok(None);
    };
    if raw.is_null() {
        return Ok(None);
    }
    let text = raw
        .as_str()
        .ok_or_else(|| format!("{key} must be a string"))?;
    if text.chars().count() > max_chars || has_disallowed_control(text) {
        return Err(format!(
            "{key} must contain at most {max_chars} non-control characters"
        ));
    }
    Ok(Some(text))
}

fn validated_string_array<'a>(
    value: &'a Value,
    key: &str,
    max_items: usize,
    max_chars: usize,
    allowed: Option<&[&str]>,
) -> Result<Option<&'a Value>, String> {
    let Some(raw) = value.get(key) else {
        return Ok(None);
    };
    if raw.is_null() {
        return Ok(None);
    }
    let items = raw
        .as_array()
        .ok_or_else(|| format!("{key} must be an array"))?;
    if items.len() > max_items {
        return Err(format!("{key} cannot contain more than {max_items} items"));
    }
    for item in items {
        let text = item
            .as_str()
            .filter(|text| !text.trim().is_empty())
            .ok_or_else(|| format!("{key} must contain non-empty strings"))?;
        if text.chars().count() > max_chars || has_disallowed_control(text) {
            return Err(format!(
                "each {key} item must be at most {max_chars} characters"
            ));
        }
        if allowed.is_some_and(|values| !values.contains(&text)) {
            return Err(format!("{key} contains an unsupported value"));
        }
    }
    Ok(Some(raw))
}

fn has_disallowed_control(text: &str) -> bool {
    text.chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
}

fn validated_limit(value: &Value) -> Result<u64, String> {
    match value.get("limit") {
        None | Some(Value::Null) => Ok(8),
        Some(raw) => raw
            .as_u64()
            .filter(|limit| (1..=20).contains(limit))
            .ok_or_else(|| "limit must be an integer from 1 to 20".into()),
    }
}

fn validated_page(value: &Value) -> Result<Option<u64>, String> {
    match value.get("page") {
        None | Some(Value::Null) => Ok(None),
        Some(raw) => raw
            .as_u64()
            .filter(|page| (1..=1_000_000).contains(page))
            .map(Some)
            .ok_or_else(|| "page must be an integer from 1 to 1000000".into()),
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
                .layer(DefaultBodyLimit::max(MAX_MCP_BODY_BYTES))
                .with_state(ServerState {
                    token: "test-secret".into(),
                    expected_host: address.to_string(),
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

    #[test]
    fn rejects_invalid_headers_and_unbounded_tool_inputs() {
        let state = ServerState {
            token: "secret".into(),
            expected_host: "127.0.0.1:1234".into(),
        };
        let mut headers = HeaderMap::new();
        headers.insert(AUTH_HEADER, "secret".parse().unwrap());
        headers.insert(header::HOST, "127.0.0.1:1234".parse().unwrap());
        headers.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
        assert_eq!(validate_request_headers(&headers, &state), Ok(()));

        headers.insert(header::ORIGIN, "https://attacker.example".parse().unwrap());
        assert_eq!(
            validate_request_headers(&headers, &state),
            Err(StatusCode::FORBIDDEN)
        );

        assert!(required_string_bounded(
            &json!({ "question": "x".repeat(MAX_TOOL_TEXT_CHARS + 1) }),
            "question",
            MAX_TOOL_TEXT_CHARS,
        )
        .is_err());
        assert!(validated_string_array(
            &json!({ "scope_ids": vec!["id"; MAX_SCOPE_ITEMS + 1] }),
            "scope_ids",
            MAX_SCOPE_ITEMS,
            MAX_IDENTIFIER_CHARS,
            None,
        )
        .is_err());
    }
}
