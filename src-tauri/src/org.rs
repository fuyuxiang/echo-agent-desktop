//! Enterprise organization client.
//!
//! The desktop only stores the remote HTTPS origin and a refresh credential.
//! Access tokens stay in Rust memory; React receives session metadata but never
//! bearer tokens. All authorization decisions remain on echo-agent-server.

use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use futures::StreamExt;
use reqwest::{Method, Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(target_os = "windows")]
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;
use url::Url;
use uuid::Uuid;

const CREDENTIAL_SERVICE: &str = "com.echoagent.organization";
const PROFILE_FILE: &str = "organization-profile.json";
const SKILL_STATE_FILE: &str = "organization-skills.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrgProfile {
    server_url: String,
    username: String,
    user_id: String,
    device_id: String,
}

#[derive(Debug, Clone, Default)]
struct OrgSession {
    profile: Option<OrgProfile>,
    access_token: Option<String>,
    refresh_token: Option<String>,
    user: Option<Value>,
    bootstrap: Option<Value>,
}

struct OrgInner {
    client: reqwest::Client,
    session: AsyncMutex<OrgSession>,
    cancellations: Mutex<HashMap<String, CancellationToken>>,
}

#[derive(Clone)]
pub struct OrgState {
    inner: Arc<OrgInner>,
}

impl Default for OrgState {
    fn default() -> Self {
        let profile = read_json::<OrgProfile>(&profile_path()).ok();
        let refresh_token = profile
            .as_ref()
            .and_then(|p| credential_read(&credential_account(p)).ok().flatten());
        Self {
            inner: Arc::new(OrgInner {
                client: reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(120))
                    .user_agent(format!("EchoAgent/{}", env!("CARGO_PKG_VERSION")))
                    .build()
                    .expect("build organization HTTP client"),
                session: AsyncMutex::new(OrgSession {
                    profile,
                    refresh_token,
                    ..Default::default()
                }),
                cancellations: Mutex::new(HashMap::new()),
            }),
        }
    }
}

static SHARED_ORG_STATE: OnceLock<OrgState> = OnceLock::new();

pub fn shared_state() -> OrgState {
    SHARED_ORG_STATE.get_or_init(OrgState::default).clone()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgSessionView {
    logged_in: bool,
    server_url: Option<String>,
    user: Option<Value>,
    bootstrap: Option<Value>,
}

fn profile_path() -> PathBuf {
    crate::paths::echo_agent_home_dir().join(PROFILE_FILE)
}

fn skill_state_path() -> PathBuf {
    crate::paths::echo_agent_home_dir().join(SKILL_STATE_FILE)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn fallback_credentials_path() -> PathBuf {
    crate::paths::echo_agent_home_dir().join("organization-credentials.json")
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse {}: {e}", path.display()))
}

fn write_json_private<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| format!("serialize: {e}"))?;
    crate::paths::write_private_file(path, &bytes)
}

fn credential_account(profile: &OrgProfile) -> String {
    let mut digest = Sha256::new();
    digest.update(profile.server_url.as_bytes());
    digest.update(b"\0");
    digest.update(profile.user_id.as_bytes());
    format!("echoagent-org-{:x}", digest.finalize())
}

#[cfg(target_os = "macos")]
fn credential_write(account: &str, secret: &str) -> Result<(), String> {
    let status = Command::new("security")
        .args([
            "add-generic-password",
            "-U",
            "-a",
            account,
            "-s",
            CREDENTIAL_SERVICE,
            "-w",
            secret,
        ])
        .status()
        .map_err(|e| format!("open macOS Keychain: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("macOS Keychain refused the organization credential".into())
    }
}

#[cfg(target_os = "macos")]
fn credential_read(account: &str) -> Result<Option<String>, String> {
    let output = Command::new("security")
        .args([
            "find-generic-password",
            "-a",
            account,
            "-s",
            CREDENTIAL_SERVICE,
            "-w",
        ])
        .output()
        .map_err(|e| format!("read macOS Keychain: {e}"))?;
    if !output.status.success() {
        return Ok(None);
    }
    Ok(Some(
        String::from_utf8_lossy(&output.stdout).trim().to_string(),
    ))
}

#[cfg(target_os = "macos")]
fn credential_delete(account: &str) -> Result<(), String> {
    let _ = Command::new("security")
        .args([
            "delete-generic-password",
            "-a",
            account,
            "-s",
            CREDENTIAL_SERVICE,
        ])
        .status();
    Ok(())
}

// Windows uses DPAPI: ciphertext is bound to the current OS user and machine.
#[cfg(target_os = "windows")]
fn credential_write(account: &str, secret: &str) -> Result<(), String> {
    let path = crate::paths::echo_agent_home_dir().join(format!(".{account}.dpapi"));
    let script = format!(
        "$s=[Console]::In.ReadToEnd();$b=[Text.Encoding]::UTF8.GetBytes($s);\
         $e=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);\
         [IO.File]::WriteAllBytes('{}',$e)",
        path.to_string_lossy().replace('\'', "''")
    );
    let mut child = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| format!("start DPAPI: {e}"))?;
    child
        .stdin
        .as_mut()
        .ok_or("DPAPI stdin unavailable")?
        .write_all(secret.as_bytes())
        .map_err(|e| format!("write DPAPI secret: {e}"))?;
    let status = child.wait().map_err(|e| format!("wait DPAPI: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("DPAPI encryption failed".into())
    }
}

#[cfg(target_os = "windows")]
fn credential_read(account: &str) -> Result<Option<String>, String> {
    let path = crate::paths::echo_agent_home_dir().join(format!(".{account}.dpapi"));
    if !path.exists() {
        return Ok(None);
    }
    let script = format!(
        "$e=[IO.File]::ReadAllBytes('{}');\
         $b=[Security.Cryptography.ProtectedData]::Unprotect($e,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);\
         [Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))",
        path.to_string_lossy().replace('\'', "''")
    );
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|e| format!("read DPAPI: {e}"))?;
    if !output.status.success() {
        return Err("DPAPI decryption failed".into());
    }
    Ok(Some(String::from_utf8_lossy(&output.stdout).to_string()))
}

#[cfg(target_os = "windows")]
fn credential_delete(account: &str) -> Result<(), String> {
    let path = crate::paths::echo_agent_home_dir().join(format!(".{account}.dpapi"));
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("delete DPAPI credential: {e}")),
    }
}

// Linux builds without a Secret Service session fall back to an owner-only file.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn credential_write(account: &str, secret: &str) -> Result<(), String> {
    let mut values =
        read_json::<HashMap<String, String>>(&fallback_credentials_path()).unwrap_or_default();
    values.insert(account.to_string(), secret.to_string());
    write_json_private(&fallback_credentials_path(), &values)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn credential_read(account: &str) -> Result<Option<String>, String> {
    Ok(
        read_json::<HashMap<String, String>>(&fallback_credentials_path())
            .unwrap_or_default()
            .remove(account),
    )
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn credential_delete(account: &str) -> Result<(), String> {
    let mut values =
        read_json::<HashMap<String, String>>(&fallback_credentials_path()).unwrap_or_default();
    values.remove(account);
    write_json_private(&fallback_credentials_path(), &values)
}

fn normalize_server_url(raw: &str) -> Result<String, String> {
    let mut url = Url::parse(raw.trim()).map_err(|e| format!("invalid server URL: {e}"))?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err(
            "organization server must use HTTPS (HTTP is only allowed for localhost)".into(),
        );
    }
    if url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("server URL must not contain credentials, query, or fragment".into());
    }
    let path = url.path().trim_end_matches('/').to_string();
    url.set_path(&path);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

fn endpoint(base: &str, path: &str) -> String {
    format!("{}{}", base.trim_end_matches('/'), path)
}

fn clear_local_session(
    session: &mut OrgSession,
    profile: Option<&OrgProfile>,
) -> Result<(), String> {
    let mut errors = Vec::new();
    if let Some(profile) = profile {
        if let Err(error) = credential_delete(&credential_account(profile)) {
            errors.push(error);
        }
    }
    if let Err(error) = std::fs::remove_file(profile_path()) {
        if error.kind() != std::io::ErrorKind::NotFound {
            errors.push(format!("delete organization profile: {error}"));
        }
    }
    *session = OrgSession::default();
    if let Err(error) = deactivate_managed_skills() {
        errors.push(error);
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn cancel_pending_requests(inner: &Arc<OrgInner>) {
    let pending = {
        let mut cancellations = inner.cancellations.lock().unwrap();
        std::mem::take(&mut *cancellations)
    };
    for token in pending.into_values() {
        token.cancel();
    }
}

async fn response_data(response: Response) -> Result<Value, String> {
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|e| format!("decode server response: {e}"))?;
    let code = value
        .get("code")
        .and_then(Value::as_i64)
        .unwrap_or(status.as_u16() as i64);
    if !status.is_success() || code != 0 {
        return Err(value
            .get("msg")
            .and_then(Value::as_str)
            .unwrap_or("organization request failed")
            .to_string());
    }
    Ok(value.get("data").cloned().unwrap_or(Value::Null))
}

async fn refresh(inner: &Arc<OrgInner>, rejected_access: &str) -> Result<(), String> {
    let mut session = inner.session.lock().await;
    if session
        .access_token
        .as_deref()
        .is_some_and(|token| token != rejected_access)
    {
        return Ok(());
    }
    let profile = session
        .profile
        .clone()
        .ok_or("not signed in to an organization")?;
    let refresh_token = session
        .refresh_token
        .clone()
        .ok_or("organization session expired")?;
    let response = inner
        .client
        .post(endpoint(&profile.server_url, "/api/v1/auth/refresh"))
        .json(&json!({ "refreshToken": refresh_token }))
        .send()
        .await
        .map_err(|e| format!("refresh organization session: {e}"))?;
    let status = response.status();
    let data = match response_data(response).await {
        Ok(data) => data,
        Err(error) => {
            if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
                let cleanup = clear_local_session(&mut session, Some(&profile));
                return Err(match cleanup {
                    Ok(()) => error,
                    Err(cleanup_error) => {
                        format!("{error}; local session cleanup: {cleanup_error}")
                    }
                });
            }
            return Err(error);
        }
    };
    let access = data
        .get("accessToken")
        .and_then(Value::as_str)
        .ok_or("refresh response missing access token")?;
    let next_refresh = data
        .get("refreshToken")
        .and_then(Value::as_str)
        .ok_or("refresh response missing refresh token")?;
    credential_write(&credential_account(&profile), next_refresh)?;
    session.access_token = Some(access.to_string());
    session.refresh_token = Some(next_refresh.to_string());
    Ok(())
}

async fn auth_snapshot(inner: &Arc<OrgInner>) -> Result<(String, String), String> {
    let session = inner.session.lock().await;
    let profile = session
        .profile
        .as_ref()
        .ok_or("not signed in to an organization")?;
    let access = session.access_token.clone().unwrap_or_default();
    Ok((profile.server_url.clone(), access))
}

async fn authenticated_response(
    inner: &Arc<OrgInner>,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Response, String> {
    for attempt in 0..2 {
        let (base, access) = auth_snapshot(inner).await?;
        if access.is_empty() {
            refresh(inner, "").await?;
            continue;
        }
        let mut request = inner
            .client
            .request(method.clone(), endpoint(&base, path))
            .bearer_auth(&access);
        if let Some(value) = body.clone() {
            request = request.json(&value);
        }
        let response = request
            .send()
            .await
            .map_err(|e| format!("organization server unreachable: {e}"))?;
        if response.status() == StatusCode::UNAUTHORIZED && attempt == 0 {
            refresh(inner, &access).await?;
            continue;
        }
        return Ok(response);
    }
    Err("organization session expired".into())
}

async fn authenticated_json(
    inner: &Arc<OrgInner>,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    response_data(authenticated_response(inner, method, path, body).await?).await
}

pub(crate) async fn mcp_json(
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    authenticated_json(&shared_state().inner, method, path, body).await
}

pub(crate) async fn mcp_ask(input: Value) -> Result<Value, String> {
    let state = shared_state();
    let response = authenticated_response(
        &state.inner,
        Method::POST,
        "/api/v1/knowledge/ask",
        Some(input),
    )
    .await?;
    if !response.status().is_success() {
        return Err(format!("knowledge ask: HTTP {}", response.status()));
    }
    let text = response
        .text()
        .await
        .map_err(|e| format!("read knowledge answer: {e}"))?;
    for block in text.split("\n\n") {
        if block.lines().any(|line| line == "event: final") {
            let data = block
                .lines()
                .filter_map(|line| line.strip_prefix("data: "))
                .collect::<Vec<_>>()
                .join("\n");
            return serde_json::from_str(&data)
                .map_err(|e| format!("decode knowledge final event: {e}"));
        }
    }
    Err("knowledge answer stream ended without a final event".into())
}

async fn update_bootstrap(inner: &Arc<OrgInner>) -> Result<Value, String> {
    let data = authenticated_json(inner, Method::GET, "/api/v1/client/bootstrap", None).await?;
    let key = decode_public_key(
        data.get("signingPublicKey")
            .and_then(Value::as_str)
            .ok_or("bootstrap missing signing public key")?,
    )?;
    let payload = data
        .get("policyPayload")
        .and_then(Value::as_str)
        .ok_or("bootstrap missing signed policy payload")?;
    let signature_text = data
        .get("policySignature")
        .and_then(Value::as_str)
        .ok_or("bootstrap missing policy signature")?;
    verify_signed_payload(&key, payload, signature_text, "organization policy")?;
    let signed_policy: Value = serde_json::from_str(payload)
        .map_err(|error| format!("decode signed organization policy: {error}"))?;
    if data.get("policy") != Some(&signed_policy) {
        return Err("organization policy payload does not match its signature".into());
    }
    let mut session = inner.session.lock().await;
    session.user = data.get("user").cloned();
    session.bootstrap = Some(data.clone());
    Ok(data)
}

fn session_view(session: &OrgSession) -> OrgSessionView {
    OrgSessionView {
        logged_in: session.profile.is_some() && session.refresh_token.is_some(),
        server_url: session.profile.as_ref().map(|p| p.server_url.clone()),
        user: session.user.clone(),
        bootstrap: session.bootstrap.clone(),
    }
}

#[tauri::command]
pub async fn org_login(
    state: State<'_, OrgState>,
    server_url: String,
    username: String,
    password: String,
) -> Result<OrgSessionView, String> {
    cancel_pending_requests(&state.inner);
    let server_url = normalize_server_url(&server_url)?;
    let device_id = Uuid::now_v7().to_string();
    let response = state
        .inner
        .client
        .post(endpoint(&server_url, "/api/v1/auth/login"))
        .json(&json!({ "username": username, "password": password, "deviceId": device_id }))
        .send()
        .await
        .map_err(|e| format!("organization server unreachable: {e}"))?;
    let data = response_data(response).await?;
    let access_token = data
        .get("accessToken")
        .and_then(Value::as_str)
        .ok_or("login response missing access token")?
        .to_string();
    let refresh_token = data
        .get("refreshToken")
        .and_then(Value::as_str)
        .ok_or("login response missing refresh token")?
        .to_string();
    let user = data
        .get("user")
        .cloned()
        .ok_or("login response missing user")?;
    let user_id = user
        .get("id")
        .and_then(Value::as_str)
        .ok_or("login response missing user id")?
        .to_string();
    let profile = OrgProfile {
        server_url,
        username,
        user_id,
        device_id,
    };
    let credential_account = credential_account(&profile);
    credential_write(&credential_account, &refresh_token)?;
    if let Err(error) = write_json_private(&profile_path(), &profile) {
        let cleanup = credential_delete(&credential_account);
        return Err(match cleanup {
            Ok(()) => error,
            Err(cleanup_error) => format!("{error}; credential cleanup: {cleanup_error}"),
        });
    }
    {
        let mut session = state.inner.session.lock().await;
        *session = OrgSession {
            profile: Some(profile),
            access_token: Some(access_token),
            refresh_token: Some(refresh_token),
            user: Some(user),
            bootstrap: None,
        };
    }
    if let Err(error) = update_bootstrap(&state.inner).await {
        let mut session = state.inner.session.lock().await;
        let profile = session.profile.clone();
        let cleanup = clear_local_session(&mut session, profile.as_ref());
        return Err(match cleanup {
            Ok(()) => error,
            Err(cleanup_error) => format!("{error}; local session cleanup: {cleanup_error}"),
        });
    }
    let session = state.inner.session.lock().await;
    Ok(session_view(&session))
}

#[tauri::command]
pub async fn org_logout(state: State<'_, OrgState>) -> Result<(), String> {
    cancel_pending_requests(&state.inner);
    let (profile, access_token) = {
        let session = state.inner.session.lock().await;
        (session.profile.clone(), session.access_token.clone())
    };
    // Local logout is the security boundary and must not wait for an offline
    // organization server. Revoke the remote device token afterwards with a
    // short timeout when an access token is available.
    let cleanup = {
        let mut session = state.inner.session.lock().await;
        clear_local_session(&mut session, profile.as_ref())
    };
    if let (Some(profile), Some(access_token)) = (&profile, access_token) {
        let _ = state
            .inner
            .client
            .post(endpoint(&profile.server_url, "/api/v1/auth/logout"))
            .bearer_auth(access_token)
            .json(&json!({}))
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await;
    }
    cleanup
}

#[tauri::command]
pub async fn org_session(state: State<'_, OrgState>) -> Result<OrgSessionView, String> {
    if state.inner.session.lock().await.profile.is_some() {
        let _ = update_bootstrap(&state.inner).await;
    }
    let session = state.inner.session.lock().await;
    Ok(session_view(&session))
}

#[tauri::command]
pub async fn org_bootstrap(state: State<'_, OrgState>) -> Result<Value, String> {
    update_bootstrap(&state.inner).await
}

#[tauri::command]
pub async fn org_list_scopes(state: State<'_, OrgState>) -> Result<Value, String> {
    let bootstrap = update_bootstrap(&state.inner).await?;
    Ok(bootstrap
        .get("scopes")
        .cloned()
        .unwrap_or_else(|| json!([])))
}

#[tauri::command]
pub async fn org_list_documents(
    state: State<'_, OrgState>,
    scope_id: Option<String>,
    query: Option<String>,
) -> Result<Value, String> {
    let mut path = Url::parse("http://local/api/v1/docs").unwrap();
    {
        let mut pairs = path.query_pairs_mut();
        if let Some(scope) = scope_id {
            pairs.append_pair("scopeId", &scope);
        }
        if let Some(query) = query {
            pairs.append_pair("q", &query);
        }
    }
    let request_path = format!(
        "{}{}",
        path.path(),
        path.query().map(|q| format!("?{q}")).unwrap_or_default()
    );
    authenticated_json(&state.inner, Method::GET, &request_path, None).await
}

#[tauri::command]
pub async fn org_document_status(
    state: State<'_, OrgState>,
    doc_id: String,
) -> Result<Value, String> {
    authenticated_json(
        &state.inner,
        Method::GET,
        &format!("/api/v1/docs/{}/status", urlencoding::encode(&doc_id)),
        None,
    )
    .await
}

#[tauri::command]
pub async fn org_fetch_document(
    state: State<'_, OrgState>,
    doc_id: String,
    page: Option<u32>,
) -> Result<Value, String> {
    authenticated_json(
        &state.inner,
        Method::POST,
        "/api/v1/docs/fetch",
        Some(json!({ "docId": doc_id, "page": page })),
    )
    .await
}

async fn authenticated_multipart(
    inner: &Arc<OrgInner>,
    path: &str,
    fields: &[(String, String)],
    file_name: &str,
    bytes: &[u8],
) -> Result<Value, String> {
    for attempt in 0..2 {
        let (base, access) = auth_snapshot(inner).await?;
        if access.is_empty() {
            refresh(inner, "").await?;
            continue;
        }
        let mut form = reqwest::multipart::Form::new();
        for (key, value) in fields {
            form = form.text(key.clone(), value.clone());
        }
        form = form.part(
            "file",
            reqwest::multipart::Part::bytes(bytes.to_vec()).file_name(file_name.to_string()),
        );
        let response = inner
            .client
            .post(endpoint(&base, path))
            .bearer_auth(&access)
            .multipart(form)
            .send()
            .await
            .map_err(|e| format!("upload to organization: {e}"))?;
        if response.status() == StatusCode::UNAUTHORIZED && attempt == 0 {
            refresh(inner, &access).await?;
            continue;
        }
        return response_data(response).await;
    }
    Err("organization session expired".into())
}

#[tauri::command]
pub async fn org_submit_document(
    state: State<'_, OrgState>,
    file_path: String,
    scope_id: String,
    title: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<Value, String> {
    let path = PathBuf::from(file_path);
    let name = path
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or("invalid file name")?
        .to_string();
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut fields = vec![("scopeId".to_string(), scope_id)];
    if let Some(title) = title {
        fields.push(("title".into(), title));
    }
    if let Some(tags) = tags {
        fields.push(("tags".into(), tags.join(",")));
    }
    authenticated_multipart(
        &state.inner,
        "/api/v1/document-submissions",
        &fields,
        &name,
        &bytes,
    )
    .await
}

#[tauri::command]
pub async fn org_document_submissions_mine(state: State<'_, OrgState>) -> Result<Value, String> {
    authenticated_json(
        &state.inner,
        Method::GET,
        "/api/v1/document-submissions/mine",
        None,
    )
    .await
}

#[tauri::command]
pub async fn org_list_skills(state: State<'_, OrgState>) -> Result<Value, String> {
    authenticated_json(&state.inner, Method::GET, "/api/v1/skills", None).await
}

#[tauri::command]
pub async fn org_submit_skill(
    state: State<'_, OrgState>,
    file_path: String,
    scope_id: String,
    version: Option<String>,
) -> Result<Value, String> {
    let path = PathBuf::from(file_path);
    let name = path
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or("invalid file name")?
        .to_string();
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut fields = vec![("scopeId".to_string(), scope_id)];
    if let Some(version) = version {
        fields.push(("version".into(), version));
    }
    authenticated_multipart(
        &state.inner,
        "/api/v1/skill-submissions",
        &fields,
        &name,
        &bytes,
    )
    .await
}

#[tauri::command]
pub async fn org_skill_submissions_mine(state: State<'_, OrgState>) -> Result<Value, String> {
    authenticated_json(
        &state.inner,
        Method::GET,
        "/api/v1/skill-submissions/mine",
        None,
    )
    .await
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
struct InstalledSkill {
    skill_id: String,
    version_id: String,
    name: String,
    path: String,
    scope_kind: String,
    mandatory: bool,
    allow_personal_override: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
struct SkillSyncState {
    cursor: String,
    lease_until: u64,
    installed: HashMap<String, InstalledSkill>,
}

fn decode_public_key(spki_base64: &str) -> Result<VerifyingKey, String> {
    let der = base64::engine::general_purpose::STANDARD
        .decode(spki_base64)
        .map_err(|e| format!("decode signing public key: {e}"))?;
    if der.len() < 32 {
        return Err("invalid Ed25519 public key".into());
    }
    let raw: [u8; 32] = der[der.len() - 32..]
        .try_into()
        .map_err(|_| "invalid Ed25519 key")?;
    VerifyingKey::from_bytes(&raw).map_err(|e| format!("invalid Ed25519 key: {e}"))
}

fn verify_signed_payload(
    public_key: &VerifyingKey,
    payload: &str,
    signature_text: &str,
    label: &str,
) -> Result<(), String> {
    let signature_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(signature_text)
        .map_err(|error| format!("decode {label} signature: {error}"))?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|error| format!("invalid {label} signature: {error}"))?;
    public_key
        .verify(payload.as_bytes(), &signature)
        .map_err(|_| format!("{label} signature verification failed"))
}

fn verify_skill_package(
    public_key: &VerifyingKey,
    item: &Value,
    bytes: &[u8],
) -> Result<(), String> {
    let expected = item
        .get("hash")
        .and_then(Value::as_str)
        .ok_or("skill sync item missing hash")?;
    let actual = format!("{:x}", Sha256::digest(bytes));
    if actual != expected {
        return Err("downloaded Skill package hash mismatch".into());
    }
    let payload = item
        .get("signaturePayload")
        .and_then(Value::as_str)
        .ok_or("skill sync item missing signature payload")?;
    let signature_text = item
        .get("signature")
        .and_then(Value::as_str)
        .ok_or("skill sync item missing signature")?;
    verify_signed_payload(public_key, payload, signature_text, "Skill package")
}

fn extract_skill_package(
    bytes: &[u8],
    skill_id: &str,
    version_id: &str,
) -> Result<PathBuf, String> {
    Uuid::parse_str(skill_id).map_err(|_| "invalid Skill id from organization server")?;
    Uuid::parse_str(version_id).map_err(|_| "invalid Skill version id from organization server")?;
    let root = crate::paths::echo_agent_home_dir()
        .join("server-skills")
        .join(skill_id);
    let final_dir = root.join(version_id);
    if final_dir.join("SKILL.md").is_file() {
        return Ok(final_dir);
    }
    std::fs::create_dir_all(&root).map_err(|e| format!("create Skill root: {e}"))?;
    let temp = root.join(format!(".{version_id}.{}.tmp", Uuid::now_v7()));
    std::fs::create_dir_all(&temp).map_err(|e| format!("create Skill staging dir: {e}"))?;
    let result = (|| -> Result<(), String> {
        let mut archive =
            zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("open Skill ZIP: {e}"))?;
        if archive.len() > 200 {
            return Err("Skill ZIP contains too many files".into());
        }
        let mut total = 0u64;
        let mut skill_entries = 0usize;
        for index in 0..archive.len() {
            let mut file = archive
                .by_index(index)
                .map_err(|e| format!("read Skill ZIP: {e}"))?;
            if file
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
            {
                return Err("Skill ZIP must not contain symbolic links".into());
            }
            total = total.saturating_add(file.size());
            if total > 20 * 1024 * 1024 {
                return Err("Skill ZIP expands beyond 20MB".into());
            }
            let relative = file
                .enclosed_name()
                .ok_or("unsafe path in Skill ZIP")?
                .to_path_buf();
            if relative.components().count() > 12 {
                return Err("Skill ZIP directory nesting is too deep".into());
            }
            if relative.file_name().is_some_and(|name| name == "SKILL.md") {
                skill_entries += 1;
                if skill_entries > 1 {
                    return Err("Skill ZIP must contain exactly one SKILL.md entry".into());
                }
            }
            let target = temp.join(relative);
            if file.is_dir() {
                std::fs::create_dir_all(&target)
                    .map_err(|e| format!("create Skill directory: {e}"))?;
                continue;
            }
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("create Skill directory: {e}"))?;
            }
            let mut output =
                std::fs::File::create(&target).map_err(|e| format!("create Skill file: {e}"))?;
            std::io::copy(&mut file, &mut output)
                .map_err(|e| format!("extract Skill file: {e}"))?;
            output
                .flush()
                .map_err(|e| format!("flush Skill file: {e}"))?;
            let mut permissions = output
                .metadata()
                .map_err(|e| format!("read Skill file permissions: {e}"))?
                .permissions();
            permissions.set_readonly(true);
            output
                .set_permissions(permissions)
                .map_err(|e| format!("protect managed Skill file: {e}"))?;
        }
        if skill_entries != 1 || !temp.join("SKILL.md").is_file() {
            return Err("Skill ZIP root must contain exactly one SKILL.md".into());
        }
        std::fs::rename(&temp, &final_dir).map_err(|e| format!("activate Skill package: {e}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&temp);
    }
    result.map(|_| final_dir)
}

fn write_runtime_skill_config(state: &SkillSyncState) -> Result<(), String> {
    let mut config = crate::providers::read_config();
    let root = config.as_table_mut().ok_or("config root is not a table")?;
    let skills = root
        .entry("skills")
        .or_insert_with(|| toml::Value::Table(Default::default()))
        .as_table_mut()
        .ok_or("[skills] is not a table")?;
    // Runtime only understands a flat Server scope, so collapse same-name
    // packages here. Normally personal > team > org. A mandatory/non-
    // overridable enterprise package wins over an unlocked personal package;
    // between protected packages the broader organization policy wins.
    let mut winners = std::collections::BTreeMap::<String, &InstalledSkill>::new();
    for candidate in state.installed.values() {
        winners
            .entry(candidate.name.clone())
            .and_modify(|current| {
                if skill_precedes(candidate, current) {
                    *current = candidate;
                }
            })
            .or_insert(candidate);
    }
    let paths = winners
        .values()
        .map(|item| toml::Value::String(item.path.clone()))
        .collect();
    let enforced = winners
        .values()
        .filter(|item| item.mandatory || !item.allow_personal_override)
        .map(|item| toml::Value::String(item.name.clone()))
        .collect();
    skills.insert("server_skill_dirs".into(), toml::Value::Array(paths));
    skills.insert(
        "server_enforced_skill_names".into(),
        toml::Value::Array(enforced),
    );
    crate::providers::write_config(&config)
}

fn skill_precedes(candidate: &InstalledSkill, current: &InstalledSkill) -> bool {
    let candidate_protected = candidate.mandatory || !candidate.allow_personal_override;
    let current_protected = current.mandatory || !current.allow_personal_override;
    if candidate_protected != current_protected {
        return candidate_protected;
    }
    let default_rank = |kind: &str| match kind {
        "personal" => 3,
        "team" => 2,
        "org" => 1,
        _ => 0,
    };
    let protected_rank = |kind: &str| match kind {
        "org" => 3,
        "team" => 2,
        "personal" => 1,
        _ => 0,
    };
    let candidate_rank = if candidate_protected {
        protected_rank(&candidate.scope_kind)
    } else {
        default_rank(&candidate.scope_kind)
    };
    let current_rank = if current_protected {
        protected_rank(&current.scope_kind)
    } else {
        default_rank(&current.scope_kind)
    };
    candidate_rank > current_rank
        || (candidate_rank == current_rank && candidate.skill_id < current.skill_id)
}

fn deactivate_managed_skills() -> Result<(), String> {
    let mut state = read_json::<SkillSyncState>(&skill_state_path()).unwrap_or_default();
    state.installed.clear();
    state.cursor.clear();
    state.lease_until = 0;
    write_runtime_skill_config(&state)?;
    write_json_private(&skill_state_path(), &state)
}

pub fn enforce_skill_lease() {
    let Ok(mut state) = read_json::<SkillSyncState>(&skill_state_path()) else {
        return;
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    if state.lease_until > 0 && state.lease_until < now {
        state.installed.clear();
        // 租约过期后下次联网必须全量同步。保留旧 cursor 会让服务端
        // 返回空增量，导致已暂停的 Skill 永远无法恢复。
        state.cursor.clear();
        state.lease_until = 0;
        if let Err(error) = write_runtime_skill_config(&state) {
            tracing::warn!(%error, "failed to enforce expired enterprise Skill lease");
        }
        if let Err(error) = write_json_private(&skill_state_path(), &state) {
            tracing::warn!(%error, "failed to persist expired enterprise Skill lease");
        }
    }
}

fn reconcile_visible_skills(
    local: &mut SkillSyncState,
    visible: &HashSet<String>,
) -> Vec<InstalledSkill> {
    let mut removed = Vec::new();
    local.installed.retain(|skill_id, item| {
        if visible.contains(skill_id) {
            true
        } else {
            removed.push(item.clone());
            false
        }
    });
    removed
}

fn remove_installed_package(item: &InstalledSkill) {
    // Sidecar 状态仍当作不可信输入：只删除 server-skills/<uuid>/<uuid>
    // 受管根下的精确版本，不使用 sidecar 中可被篡改的 path 字段删文件。
    if Uuid::parse_str(&item.skill_id).is_err() || Uuid::parse_str(&item.version_id).is_err() {
        tracing::warn!(skill_id = %item.skill_id, version_id = %item.version_id, "refused unsafe managed Skill cleanup path");
        return;
    }
    let family_dir = crate::paths::echo_agent_home_dir()
        .join("server-skills")
        .join(&item.skill_id);
    let version_dir = family_dir.join(&item.version_id);
    if let Err(error) = std::fs::remove_dir_all(&version_dir) {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(%error, path = %version_dir.display(), "failed to remove revoked managed Skill package");
        }
    }
    let _ = std::fs::remove_dir(&family_dir);
}

#[tauri::command]
pub async fn org_sync_skills(state: State<'_, OrgState>) -> Result<Value, String> {
    let mut local = read_json::<SkillSyncState>(&skill_state_path()).unwrap_or_default();
    let path = format!(
        "/api/v1/skills/sync?cursor={}",
        urlencoding::encode(&local.cursor)
    );
    let data = authenticated_json(&state.inner, Method::GET, &path, None).await?;
    let bootstrap = update_bootstrap(&state.inner).await?;
    let key_text = bootstrap
        .get("signingPublicKey")
        .and_then(Value::as_str)
        .ok_or("bootstrap missing signing public key")?;
    let public_key = decode_public_key(key_text)?;
    let upserts = data
        .get("upserts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut obsolete_packages = Vec::new();
    for item in upserts {
        let package_url = item
            .get("packageUrl")
            .and_then(Value::as_str)
            .ok_or("Skill item missing package URL")?;
        let response = authenticated_response(&state.inner, Method::GET, package_url, None).await?;
        if !response.status().is_success() {
            return Err(format!("download Skill: HTTP {}", response.status()));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|e| format!("read Skill package: {e}"))?;
        verify_skill_package(&public_key, &item, &bytes)?;
        let skill_id = item
            .get("skillId")
            .and_then(Value::as_str)
            .ok_or("Skill item missing id")?;
        let version_id = item
            .get("versionId")
            .and_then(Value::as_str)
            .ok_or("Skill item missing version id")?;
        let install_path = extract_skill_package(&bytes, skill_id, version_id)?;
        let installed = InstalledSkill {
            skill_id: skill_id.to_string(),
            version_id: version_id.to_string(),
            name: item
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(skill_id)
                .to_string(),
            path: install_path.to_string_lossy().into_owned(),
            scope_kind: item
                .get("scopeKind")
                .and_then(Value::as_str)
                .unwrap_or("org")
                .to_string(),
            mandatory: item
                .get("mandatory")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            allow_personal_override: item
                .get("allowPersonalOverride")
                .and_then(Value::as_bool)
                .unwrap_or(true),
        };
        if let Some(previous) = local.installed.insert(skill_id.to_string(), installed) {
            if previous.version_id != version_id {
                obsolete_packages.push(previous);
            }
        }
    }
    for revoked in data
        .get("revoked")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        if let Some(skill_id) = revoked.get("skillId").and_then(Value::as_str) {
            if let Some(previous) = local.installed.remove(skill_id) {
                obsolete_packages.push(previous);
            }
        }
    }
    if let Some(visible_ids) = data.get("visibleSkillIds").and_then(Value::as_array) {
        let visible = visible_ids
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<HashSet<_>>();
        obsolete_packages.extend(reconcile_visible_skills(&mut local, &visible));
    }
    local.cursor = data
        .get("nextCursor")
        .and_then(Value::as_str)
        .unwrap_or(&local.cursor)
        .to_string();
    local.lease_until = data.get("leaseUntil").and_then(Value::as_u64).unwrap_or(0);
    write_runtime_skill_config(&local)?;
    write_json_private(&skill_state_path(), &local)?;
    for item in &obsolete_packages {
        remove_installed_package(item);
    }
    Ok(json!({
        "cursor": local.cursor,
        "leaseUntil": local.lease_until,
        "installed": local.installed.values().collect::<Vec<_>>()
    }))
}

async fn run_ask_stream(
    app: AppHandle,
    state: OrgState,
    request_id: String,
    cancel: CancellationToken,
    input: Value,
) -> Result<(), String> {
    let response = authenticated_response(
        &state.inner,
        Method::POST,
        "/api/v1/knowledge/ask",
        Some(input),
    )
    .await?;
    if !response.status().is_success() {
        return Err(format!("knowledge ask: HTTP {}", response.status()));
    }
    let mut stream = response.bytes_stream();
    // Keep raw bytes until a complete SSE frame is available. Decoding every
    // network chunk independently can corrupt UTF-8 when a Chinese character
    // is split across two chunks.
    let mut pending = Vec::new();
    let mut terminal_seen = false;
    loop {
        let next = tokio::select! {
            _ = cancel.cancelled() => break,
            value = stream.next() => value,
        };
        let Some(chunk) = next else {
            break;
        };
        let chunk = chunk.map_err(|e| format!("read answer stream: {e}"))?;
        pending.extend_from_slice(&chunk);
        for (event, payload) in drain_sse_events(&mut pending)? {
            terminal_seen |= matches!(event.as_str(), "final" | "error");
            let _ = app.emit(
                "org://ask-event",
                json!({ "requestId": request_id, "event": event, "data": payload }),
            );
        }
    }
    if cancel.is_cancelled() {
        return Ok(());
    }
    // A compliant sender normally terminates every event with a blank line,
    // but accept a final unterminated frame when the connection closes cleanly.
    if !pending.iter().all(u8::is_ascii_whitespace) {
        let (event, payload) = parse_sse_block(&pending)?;
        terminal_seen |= matches!(event.as_str(), "final" | "error");
        let _ = app.emit(
            "org://ask-event",
            json!({ "requestId": request_id, "event": event, "data": payload }),
        );
    }
    if terminal_seen {
        Ok(())
    } else {
        Err("knowledge answer stream ended without a final event".into())
    }
}

fn sse_boundary(bytes: &[u8]) -> Option<(usize, usize)> {
    let lf = bytes.windows(2).position(|window| window == b"\n\n");
    let crlf = bytes.windows(4).position(|window| window == b"\r\n\r\n");
    match (lf, crlf) {
        (Some(left), Some(right)) if left <= right => Some((left, 2)),
        (Some(_), Some(right)) => Some((right, 4)),
        (Some(index), None) => Some((index, 2)),
        (None, Some(index)) => Some((index, 4)),
        (None, None) => None,
    }
}

fn parse_sse_block(block: &[u8]) -> Result<(String, Value), String> {
    let text = std::str::from_utf8(block).map_err(|e| format!("decode answer stream: {e}"))?;
    let mut event = "message";
    let mut data = Vec::new();
    for raw_line in text.lines() {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if let Some(value) = line.strip_prefix("event:") {
            event = value.strip_prefix(' ').unwrap_or(value);
        } else if let Some(value) = line.strip_prefix("data:") {
            data.push(value.strip_prefix(' ').unwrap_or(value));
        }
    }
    let data = data.join("\n");
    let payload = serde_json::from_str::<Value>(&data).unwrap_or(Value::String(data));
    Ok((event.to_string(), payload))
}

fn drain_sse_events(pending: &mut Vec<u8>) -> Result<Vec<(String, Value)>, String> {
    let mut events = Vec::new();
    while let Some((index, separator_len)) = sse_boundary(pending) {
        let block = pending[..index].to_vec();
        pending.drain(..index + separator_len);
        if !block.iter().all(u8::is_ascii_whitespace) {
            events.push(parse_sse_block(&block)?);
        }
    }
    Ok(events)
}

#[tauri::command]
pub async fn org_ask_start(
    app: AppHandle,
    state: State<'_, OrgState>,
    question: String,
    mode: Option<String>,
    scope_kinds: Option<Vec<String>>,
    scope_ids: Option<Vec<String>>,
) -> Result<String, String> {
    let request_id = Uuid::now_v7().to_string();
    let cancel = CancellationToken::new();
    state
        .inner
        .cancellations
        .lock()
        .unwrap()
        .insert(request_id.clone(), cancel.clone());
    let owned_state = state.inner.clone();
    let task_state = OrgState {
        inner: owned_state.clone(),
    };
    let task_id = request_id.clone();
    let mut input = json!({
        "question": question,
        "mode": mode.unwrap_or_else(|| "auto".into()),
    });
    if let Some(kinds) = scope_kinds {
        input["scopeKinds"] = json!(kinds);
    }
    if let Some(ids) = scope_ids {
        input["scopeIds"] = json!(ids);
    }
    tauri::async_runtime::spawn(async move {
        let result = run_ask_stream(app.clone(), task_state, task_id.clone(), cancel, input).await;
        if let Err(error) = result {
            let _ = app.emit(
                "org://ask-event",
                json!({
                    "requestId": task_id,
                    "event": "error",
                    "data": { "message": error }
                }),
            );
        }
        owned_state.cancellations.lock().unwrap().remove(&task_id);
    });
    Ok(request_id)
}

#[tauri::command]
pub fn org_ask_cancel(state: State<'_, OrgState>, request_id: String) -> bool {
    if let Some(cancel) = state
        .inner
        .cancellations
        .lock()
        .unwrap()
        .remove(&request_id)
    {
        cancel.cancel();
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_url_requires_tls_except_loopback() {
        assert!(normalize_server_url("https://memory.example.com/").is_ok());
        assert!(normalize_server_url("http://127.0.0.1:8787").is_ok());
        assert!(normalize_server_url("http://memory.example.com").is_err());
        assert!(normalize_server_url("https://u:p@memory.example.com").is_err());
    }

    #[test]
    fn sse_parser_preserves_unicode_split_between_network_chunks() {
        let frame = "event: delta\ndata: {\"text\":\"组织记忆\"}\n\n";
        let mut pending = Vec::new();
        let mut events = Vec::new();
        for chunk in frame.as_bytes().chunks(2) {
            pending.extend_from_slice(chunk);
            events.extend(drain_sse_events(&mut pending).unwrap());
        }
        assert!(pending.is_empty());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "delta");
        assert_eq!(events[0].1, json!({ "text": "组织记忆" }));
    }

    #[test]
    fn sse_parser_accepts_crlf_and_multiline_data() {
        let mut pending = b"event: status\r\ndata: first\r\ndata: second\r\n\r\n".to_vec();
        let events = drain_sse_events(&mut pending).unwrap();
        assert!(pending.is_empty());
        assert_eq!(
            events,
            vec![("status".into(), Value::String("first\nsecond".into()))]
        );
    }

    #[test]
    fn logout_cancellation_drains_all_pending_requests() {
        let first = CancellationToken::new();
        let second = CancellationToken::new();
        let inner = Arc::new(OrgInner {
            client: reqwest::Client::new(),
            session: AsyncMutex::new(OrgSession::default()),
            cancellations: Mutex::new(HashMap::from([
                ("first".into(), first.clone()),
                ("second".into(), second.clone()),
            ])),
        });
        cancel_pending_requests(&inner);
        assert!(first.is_cancelled());
        assert!(second.is_cancelled());
        assert!(inner.cancellations.lock().unwrap().is_empty());
    }

    fn installed(id: &str, scope: &str, protected: bool) -> InstalledSkill {
        InstalledSkill {
            skill_id: id.into(),
            version_id: "v1".into(),
            name: "shared-skill".into(),
            path: format!("/{id}"),
            scope_kind: scope.into(),
            mandatory: false,
            allow_personal_override: !protected,
        }
    }

    #[test]
    fn managed_skill_precedence_honors_scope_and_enterprise_lock() {
        let personal = installed("personal", "personal", false);
        let team = installed("team", "team", false);
        let locked_org = installed("org", "org", true);
        assert!(skill_precedes(&personal, &team));
        assert!(!skill_precedes(&team, &personal));
        assert!(skill_precedes(&locked_org, &personal));
    }

    #[test]
    fn authoritative_visibility_removes_skills_after_scope_revocation() {
        let mut state = SkillSyncState::default();
        state
            .installed
            .insert("visible".into(), installed("visible", "team", false));
        state
            .installed
            .insert("revoked".into(), installed("revoked", "team", false));
        let removed = reconcile_visible_skills(&mut state, &HashSet::from(["visible".to_string()]));
        assert!(state.installed.contains_key("visible"));
        assert!(!state.installed.contains_key("revoked"));
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].skill_id, "revoked");
    }
}
