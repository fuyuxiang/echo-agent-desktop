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
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;
use url::Url;
use uuid::Uuid;
#[cfg(target_os = "windows")]
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    },
};

const CREDENTIAL_SERVICE: &str = "com.echoagent.organization";
const PROFILE_FILE: &str = "organization-profile.json";
const SKILL_STATE_FILE: &str = "organization-skills.json";
const LOCAL_KB_SOURCES_FILE: &str = "local-knowledge-sources.json";
const ORGANIZATION_CA_PEM: &[u8] = include_bytes!("../certs/echo-agent-server-ca.pem");

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
        // This private CA only augments the organization HTTP client. Model
        // providers, MCP servers, and every other outbound client keep their
        // existing public-root trust policy.
        let organization_ca = reqwest::Certificate::from_pem(ORGANIZATION_CA_PEM)
            .expect("embedded organization CA certificate must be valid PEM");
        Self {
            inner: Arc::new(OrgInner {
                client: reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(120))
                    .user_agent(format!("EchoAgent/{}", env!("CARGO_PKG_VERSION")))
                    .add_root_certificate(organization_ca)
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

/// Organization packages live under the same user-global Skills tree scanned
/// by the Expert · Skills · Connectors page and by the Agent Runtime.
fn organization_skills_root() -> PathBuf {
    crate::paths::echo_agent_home_dir()
        .join("skills")
        .join("organization")
}

fn notify_skills_changed(app: &AppHandle, reason: &str) {
    let runtime = app.state::<crate::commands::AppState>();
    if let Err(error) = crate::agent_admin::request_internal_reload(&runtime, "skills") {
        if error == "agent not initialized" {
            tracing::debug!(%reason, "organization Skills changed before agent initialization");
        } else {
            tracing::warn!(%error, %reason, "failed to hot-reload organization Skills");
        }
    }
    if let Err(error) = app.emit("org://skills-changed", json!({ "reason": reason })) {
        tracing::debug!(%error, %reason, "failed to emit organization Skill change event");
    }
}

fn notify_models_changed(app: &AppHandle, reason: &str) {
    let runtime = app.state::<crate::commands::AppState>();
    if let Err(error) = crate::agent_admin::request_internal_reload(&runtime, "models") {
        if error == "agent not initialized" {
            tracing::debug!(%reason, "organization model synced before agent initialization");
        } else {
            tracing::warn!(%error, %reason, "failed to hot-reload organization model");
        }
    }
}

pub(crate) fn local_kb_sources_path() -> PathBuf {
    crate::paths::echo_agent_home_dir().join(LOCAL_KB_SOURCES_FILE)
}

#[tauri::command]
pub fn org_local_kb_sources_get() -> Result<Value, String> {
    let path = local_kb_sources_path();
    if !path.exists() {
        return Ok(Value::Array(Vec::new()));
    }
    let value: Value = read_json(&path)?;
    if !value.is_array() {
        return Err("local knowledge sources store must be an array".into());
    }
    Ok(value)
}

#[tauri::command]
pub fn org_local_kb_sources_set(sources: Value) -> Result<(), String> {
    let items = sources
        .as_array()
        .ok_or("local knowledge sources must be an array")?;
    if items.len() > 50 {
        return Err("too many local knowledge sources".into());
    }
    let mut normalized = Vec::new();
    for item in items {
        let root = item
            .get("root")
            .and_then(Value::as_str)
            .ok_or("local knowledge source missing root")?;
        let path = PathBuf::from(root);
        if !path.is_absolute() || !path.is_dir() {
            return Err(format!(
                "local knowledge source is not an existing absolute directory: {root}"
            ));
        }
        normalized.push(json!({
            "id": item.get("id").and_then(Value::as_str).unwrap_or("local"),
            "kind": "local-folder",
            "label": item.get("label").and_then(Value::as_str).unwrap_or("local"),
            "root": path.to_string_lossy(),
            "enabled": item.get("enabled").and_then(Value::as_bool).unwrap_or(true)
        }));
    }
    write_json_private(&local_kb_sources_path(), &normalized)
}

pub(crate) async fn local_knowledge_allowed() -> bool {
    let state = shared_state();
    if state.inner.session.lock().await.profile.is_none() {
        return true;
    }
    match update_bootstrap(&state.inner).await {
        Ok(bootstrap) => bootstrap
            .get("policy")
            .and_then(|policy| policy.get("allowLocalKnowledge"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        Err(_) => false,
    }
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

fn signing_key_account(profile: &OrgProfile) -> String {
    format!("{}-signing-key", credential_account(profile))
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

// Windows uses DPAPI directly: ciphertext is bound to the current OS user and
// machine. Keep the raw DPAPI blob on disk so files created by the retired
// PowerShell implementation remain readable.
#[cfg(target_os = "windows")]
#[derive(Default)]
struct DpapiBuffer(CRYPT_INTEGER_BLOB);

#[cfg(target_os = "windows")]
impl DpapiBuffer {
    fn to_vec(&self) -> Result<Vec<u8>, String> {
        if self.0.cbData == 0 {
            return Ok(Vec::new());
        }
        if self.0.pbData.is_null() {
            return Err("DPAPI returned a null output buffer".into());
        }
        // SAFETY: CryptProtectData/CryptUnprotectData returned this allocation
        // and cbData is its initialized byte length. Copy before the allocation
        // is zeroed and released by Drop.
        Ok(unsafe { std::slice::from_raw_parts(self.0.pbData, self.0.cbData as usize) }.to_vec())
    }
}

#[cfg(target_os = "windows")]
impl Drop for DpapiBuffer {
    fn drop(&mut self) {
        if self.0.pbData.is_null() {
            return;
        }
        // SAFETY: DPAPI allocates output with LocalAlloc. Zeroing before
        // LocalFree prevents decrypted credentials lingering in freed memory.
        unsafe {
            std::ptr::write_bytes(self.0.pbData, 0, self.0.cbData as usize);
            let result = LocalFree(self.0.pbData.cast());
            debug_assert!(result.is_null(), "LocalFree rejected a DPAPI buffer");
        }
        self.0 = CRYPT_INTEGER_BLOB::default();
    }
}

#[cfg(target_os = "windows")]
fn dpapi_input(bytes: &[u8]) -> Result<CRYPT_INTEGER_BLOB, String> {
    let length = u32::try_from(bytes.len()).map_err(|_| "DPAPI input exceeds 4 GiB")?;
    Ok(CRYPT_INTEGER_BLOB {
        cbData: length,
        pbData: if bytes.is_empty() {
            std::ptr::null_mut()
        } else {
            bytes.as_ptr().cast_mut()
        },
    })
}

#[cfg(target_os = "windows")]
fn dpapi_protect(plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let input = dpapi_input(plaintext)?;
    let mut output = DpapiBuffer::default();
    // SAFETY: all optional pointers are null as allowed by CryptProtectData;
    // input points to plaintext for input.cbData bytes and output is writable.
    let success = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output.0,
        )
    };
    if success == 0 {
        return Err(format!(
            "DPAPI encryption failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    output.to_vec()
}

#[cfg(target_os = "windows")]
fn dpapi_unprotect(ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    let input = dpapi_input(ciphertext)?;
    let mut output = DpapiBuffer::default();
    // SAFETY: all optional pointers are null as allowed by CryptUnprotectData;
    // input points to ciphertext for input.cbData bytes and output is writable.
    let success = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output.0,
        )
    };
    if success == 0 {
        return Err(format!(
            "DPAPI decryption failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    output.to_vec()
}

#[cfg(target_os = "windows")]
fn credential_write(account: &str, secret: &str) -> Result<(), String> {
    let path = crate::paths::echo_agent_home_dir().join(format!(".{account}.dpapi"));
    let encrypted = dpapi_protect(secret.as_bytes())?;
    crate::paths::write_private_file(&path, &encrypted)
        .map_err(|e| format!("write DPAPI credential {}: {e}", path.display()))
}

#[cfg(target_os = "windows")]
fn credential_read(account: &str) -> Result<Option<String>, String> {
    let path = crate::paths::echo_agent_home_dir().join(format!(".{account}.dpapi"));
    if !path.exists() {
        return Ok(None);
    }
    let encrypted = std::fs::read(&path)
        .map_err(|e| format!("read DPAPI credential {}: {e}", path.display()))?;
    let plaintext = dpapi_unprotect(&encrypted)?;
    String::from_utf8(plaintext)
        .map(Some)
        .map_err(|e| format!("DPAPI credential is not valid UTF-8: {e}"))
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
        if let Err(error) = credential_delete(&signing_key_account(profile)) {
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

/// Download the organization's complete chat credential and persist it using
/// the same provider/model schema as models created manually in Settings.
async fn sync_organization_model_config(inner: &Arc<OrgInner>) -> Result<Option<String>, String> {
    let data = authenticated_json(inner, Method::GET, "/api/v1/client/model-config", None).await?;
    if data
        .get("credentialError")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err("organization model credential cannot be decrypted".into());
    }
    if !data
        .get("configured")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Ok(None);
    }

    let required = |key: &str| -> Result<String, String> {
        data.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .ok_or_else(|| format!("organization model config missing {key}"))
    };
    let model_id = crate::providers::save_organization_model_config(
        crate::providers::OrganizationModelConfig {
            provider: required("chatProvider")?,
            model: required("chatModel")?,
            base_url: required("chatBaseUrl")?,
            api_key: required("chatKey")?,
        },
    )?;
    Ok(Some(model_id))
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
    let key_text = data
        .get("signingPublicKey")
        .and_then(Value::as_str)
        .ok_or("bootstrap missing signing public key")?;
    let key = decode_public_key(key_text)?;
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
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let issued_at = signed_policy
        .get("issuedAt")
        .and_then(Value::as_u64)
        .ok_or("organization policy missing issuedAt")?;
    let expires_at = signed_policy
        .get("expiresAt")
        .and_then(Value::as_u64)
        .ok_or("organization policy missing expiresAt")?;
    if expires_at <= now || issued_at > now.saturating_add(5 * 60_000) || expires_at <= issued_at {
        return Err("organization policy is expired or has an invalid validity window".into());
    }
    let next_version = signed_policy
        .get("version")
        .and_then(Value::as_u64)
        .ok_or("organization policy missing version")?;
    let mut session = inner.session.lock().await;
    let profile = session
        .profile
        .as_ref()
        .ok_or("organization profile missing")?;
    let key_account = signing_key_account(profile);
    match credential_read(&key_account)? {
        Some(pinned) if pinned != key_text => {
            return Err(
                "organization signing key changed; explicit administrator migration is required"
                    .into(),
            )
        }
        None => credential_write(&key_account, key_text)?,
        Some(_) => {}
    }
    let prior_version = session
        .bootstrap
        .as_ref()
        .and_then(|value| value.get("policy"))
        .and_then(|value| value.get("version"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if next_version < prior_version {
        return Err("organization policy rollback was rejected".into());
    }
    session.user = data.get("user").cloned();
    session.bootstrap = Some(data.clone());
    Ok(data)
}

async fn require_policy(inner: &Arc<OrgInner>, key: &str) -> Result<(), String> {
    let bootstrap = update_bootstrap(inner).await?;
    if bootstrap
        .get("policy")
        .and_then(|policy| policy.get(key))
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        Ok(())
    } else {
        Err(format!("organization policy disables {key}"))
    }
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
    app: AppHandle,
    state: State<'_, OrgState>,
    server_url: String,
    username: String,
    password: String,
) -> Result<OrgSessionView, String> {
    cancel_pending_requests(&state.inner);
    // 账号切换时先从 Runtime 移除上一账号的受管 Skill，
    // 新账号同步失败也不得继续使用旧权限。
    let deactivation = deactivate_managed_skills();
    notify_skills_changed(&app, "account-switch");
    deactivation?;
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
    // 模型凭证优先同步，避免受管 Skill 包下载延迟模型进入 Runtime。
    match sync_organization_model_config(&state.inner).await {
        Ok(Some(model_id)) => {
            tracing::info!(%model_id, "organization model configuration downloaded");
            notify_models_changed(&app, "login-sync");
        }
        Ok(None) => tracing::debug!("organization chat model is not configured"),
        Err(error) => tracing::warn!(%error, "initial organization model sync failed"),
    }
    // 登录即同步。失败不退出账号，但受管 Skill 保持已停用，
    // 避免网络短暂抖动迫使用户重新输入密码。
    match sync_skills(&state.inner).await {
        Ok(_) => notify_skills_changed(&app, "login-sync"),
        Err(error) => tracing::warn!(%error, "initial managed Skill sync failed"),
    }
    let session = state.inner.session.lock().await;
    Ok(session_view(&session))
}

#[tauri::command]
pub async fn org_logout(app: AppHandle, state: State<'_, OrgState>) -> Result<(), String> {
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
    notify_skills_changed(&app, "logout");
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
pub async fn org_session(
    app: AppHandle,
    state: State<'_, OrgState>,
) -> Result<OrgSessionView, String> {
    if state.inner.session.lock().await.profile.is_some() {
        if update_bootstrap(&state.inner).await.is_ok() {
            match sync_organization_model_config(&state.inner).await {
                Ok(Some(model_id)) => {
                    tracing::info!(%model_id, "organization model configuration restored");
                    notify_models_changed(&app, "session-restore");
                }
                Ok(None) => {}
                Err(error) => tracing::warn!(%error, "organization model restore failed"),
            }
            let _ = sync_skills(&state.inner).await;
        } else {
            enforce_skill_lease();
        }
        notify_skills_changed(&app, "session-restore");
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

fn document_fetch_body(doc_id: String, page: Option<u32>) -> Value {
    let mut body = json!({ "docId": doc_id });
    if let Some(page) = page {
        body["page"] = json!(page);
    }
    body
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
        Some(document_fetch_body(doc_id, page)),
    )
    .await
}

#[tauri::command]
pub async fn org_archive_document(
    state: State<'_, OrgState>,
    doc_id: String,
) -> Result<Value, String> {
    authenticated_json(
        &state.inner,
        Method::DELETE,
        &format!("/api/v1/docs/{}", urlencoding::encode(&doc_id)),
        None,
    )
    .await
}

#[tauri::command]
pub async fn org_new_document_version(
    state: State<'_, OrgState>,
    doc_id: String,
    file_path: String,
) -> Result<Value, String> {
    let path = PathBuf::from(file_path);
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("invalid file name")?
        .to_string();
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|error| format!("read {}: {error}", path.display()))?;
    authenticated_multipart(
        &state.inner,
        &format!("/api/v1/docs/{}/new-version", urlencoding::encode(&doc_id)),
        &[],
        &name,
        &bytes,
    )
    .await
}

#[tauri::command]
pub async fn org_publish_document(
    state: State<'_, OrgState>,
    doc_id: String,
    target_scope_id: String,
) -> Result<Value, String> {
    authenticated_json(
        &state.inner,
        Method::POST,
        &format!("/api/v1/docs/{}/publish", urlencoding::encode(&doc_id)),
        Some(json!({ "targetScopeId": target_scope_id })),
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
    let bootstrap = update_bootstrap(&state.inner).await?;
    let is_personal = bootstrap
        .get("scopes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|scope| {
            scope.get("id").and_then(Value::as_str) == Some(scope_id.as_str())
                && scope.get("kind").and_then(Value::as_str) == Some("personal")
        });
    if is_personal
        && !bootstrap
            .get("policy")
            .and_then(|policy| policy.get("allowPersonalCloud"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return Err("organization policy disables personal cloud knowledge".into());
    }
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
pub async fn org_skill_detail(
    state: State<'_, OrgState>,
    skill_id: String,
) -> Result<Value, String> {
    authenticated_json(
        &state.inner,
        Method::GET,
        &format!("/api/v1/skills/{}", urlencoding::encode(&skill_id)),
        None,
    )
    .await
}

#[tauri::command]
pub async fn org_set_skill_preference(
    app: AppHandle,
    state: State<'_, OrgState>,
    skill_id: String,
    enabled: bool,
) -> Result<Value, String> {
    let result = authenticated_json(
        &state.inner,
        Method::PUT,
        &format!(
            "/api/v1/skills/{}/preference",
            urlencoding::encode(&skill_id)
        ),
        Some(json!({ "enabled": enabled })),
    )
    .await?;
    // A preference update and the preceding sync cursor can share the same
    // millisecond. Force a full fetch when installing so the newly enabled
    // package cannot be skipped by the server's strict `updated_at > cursor`.
    if enabled {
        let mut local = read_json::<SkillSyncState>(&skill_state_path()).unwrap_or_default();
        local.cursor.clear();
        write_json_private(&skill_state_path(), &local)?;
    }
    sync_skills(&state.inner).await?;
    notify_skills_changed(&app, "preference");
    Ok(result)
}

#[tauri::command]
pub async fn org_publish_skill(
    state: State<'_, OrgState>,
    skill_id: String,
    target_scope_id: String,
) -> Result<Value, String> {
    require_policy(&state.inner, "allowSkillSubmission").await?;
    authenticated_json(
        &state.inner,
        Method::POST,
        &format!("/api/v1/skills/{}/publish", urlencoding::encode(&skill_id)),
        Some(json!({ "targetScopeId": target_scope_id })),
    )
    .await
}

#[tauri::command]
pub async fn org_qa_feedback(
    state: State<'_, OrgState>,
    qa_event_id: String,
    feedback: String,
) -> Result<Value, String> {
    authenticated_json(
        &state.inner,
        Method::POST,
        &format!(
            "/api/v1/qa-events/{}/feedback",
            urlencoding::encode(&qa_event_id)
        ),
        Some(json!({ "feedback": feedback })),
    )
    .await
}

#[tauri::command]
pub async fn org_submit_skill(
    state: State<'_, OrgState>,
    file_path: String,
    scope_id: String,
    version: Option<String>,
) -> Result<Value, String> {
    require_policy(&state.inner, "allowSkillSubmission").await?;
    let path = PathBuf::from(file_path);
    let is_zip = path.is_file()
        && path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("zip"));
    let (name, bytes) = if is_zip {
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or("invalid file name")?
            .to_string();
        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|error| format!("read {}: {error}", path.display()))?;
        (name, bytes)
    } else {
        let source = path.to_string_lossy().into_owned();
        tauri::async_runtime::spawn_blocking(move || {
            crate::skill_installer::package_skill_for_upload(&source)
        })
        .await
        .map_err(|error| format!("打包 Skill 失败：{error}"))??
    };
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
    version: String,
    name: String,
    path: String,
    package_path: String,
    hash: String,
    signature_payload: String,
    signature: String,
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

#[derive(Debug, Clone)]
pub(crate) struct ManagedSkillMetadata {
    pub skill_id: String,
    pub version_id: String,
    pub version: String,
    pub scope_kind: String,
    pub mandatory: bool,
    pub allow_personal_override: bool,
}

/// Return trusted organization metadata keyed by each installed directory.
/// Validation reads every signed package, so callers obtain the complete map
/// once and reuse it while annotating a Runtime skill listing.
pub(crate) fn managed_skills_metadata() -> Vec<(PathBuf, ManagedSkillMetadata)> {
    let Ok(state) = read_json::<SkillSyncState>(&skill_state_path()) else {
        return Vec::new();
    };
    if validate_skill_state(&state).is_err() {
        return Vec::new();
    }
    state
        .installed
        .values()
        .map(|item| {
            (
                PathBuf::from(&item.path),
                ManagedSkillMetadata {
                    skill_id: item.skill_id.clone(),
                    version_id: item.version_id.clone(),
                    version: item.version.clone(),
                    scope_kind: item.scope_kind.clone(),
                    mandatory: item.mandatory,
                    allow_personal_override: item.allow_personal_override,
                },
            )
        })
        .collect()
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
    verify_signed_payload(public_key, payload, signature_text, "Skill package")?;
    let signed: Value = serde_json::from_str(payload)
        .map_err(|error| format!("decode signed Skill manifest: {error}"))?;
    let checks = [
        ("skillId", item.get("skillId")),
        ("versionId", item.get("versionId")),
        ("version", item.get("version")),
        ("hash", item.get("hash")),
        ("scopeKind", item.get("scopeKind")),
        ("mandatory", item.get("mandatory")),
        ("allowPersonalOverride", item.get("allowPersonalOverride")),
    ];
    if signed.get("schema").and_then(Value::as_str) != Some("echo-managed-skill/v2") {
        return Err("unsupported signed Skill manifest schema".into());
    }
    for (key, expected) in checks {
        if signed.get(key) != expected {
            return Err(format!(
                "signed Skill field does not match sync item: {key}"
            ));
        }
    }
    Ok(())
}

fn verify_installed_skill(public_key: &VerifyingKey, item: &InstalledSkill) -> Result<(), String> {
    verify_signed_payload(
        public_key,
        &item.signature_payload,
        &item.signature,
        "installed Skill",
    )?;
    let signed: Value = serde_json::from_str(&item.signature_payload)
        .map_err(|error| format!("decode installed Skill manifest: {error}"))?;
    let expected = json!({
        "schema": "echo-managed-skill/v2",
        "skillId": item.skill_id,
        "versionId": item.version_id,
        "version": item.version,
        "hash": item.hash,
        "scopeKind": item.scope_kind,
        "mandatory": item.mandatory,
        "allowPersonalOverride": item.allow_personal_override
    });
    if signed != expected {
        return Err("installed Skill sidecar differs from its signed manifest".into());
    }
    let canonical = organization_skills_root()
        .join(&item.skill_id)
        .join(&item.version_id);
    if item.path != canonical.to_string_lossy() || !canonical.join("SKILL.md").is_file() {
        return Err("installed Skill path is not canonical or its entry is missing".into());
    }
    let canonical_package = organization_skills_root()
        .join(".packages")
        .join(&item.skill_id)
        .join(format!("{}.zip", item.version_id));
    if item.package_path != canonical_package.to_string_lossy() {
        return Err("installed Skill package cache path is not canonical".into());
    }
    let package = std::fs::read(&canonical_package)
        .map_err(|error| format!("read installed Skill package cache: {error}"))?;
    if format!("{:x}", Sha256::digest(&package)) != item.hash {
        return Err("installed Skill package cache hash mismatch".into());
    }
    verify_extracted_skill(&package, &canonical)?;
    Ok(())
}

fn collect_installed_files(
    root: &Path,
    directory: &Path,
    files: &mut HashSet<PathBuf>,
) -> Result<(), String> {
    for entry in std::fs::read_dir(directory)
        .map_err(|error| format!("read installed Skill directory: {error}"))?
    {
        let entry = entry.map_err(|error| format!("read installed Skill entry: {error}"))?;
        let kind = entry
            .file_type()
            .map_err(|error| format!("read installed Skill file type: {error}"))?;
        if kind.is_symlink() {
            return Err("installed Skill contains a symbolic link".into());
        }
        if kind.is_dir() {
            collect_installed_files(root, &entry.path(), files)?;
        } else if kind.is_file() {
            let entry_path = entry.path();
            let relative = entry_path
                .strip_prefix(root)
                .map_err(|_| "installed Skill file escaped its root")?
                .to_path_buf();
            files.insert(relative);
        } else {
            return Err("installed Skill contains an unsupported filesystem entry".into());
        }
    }
    Ok(())
}

/// File permissions are not a security boundary for the desktop user. Compare
/// every extracted byte and the complete file set with the immutable signed ZIP
/// before injecting the package into the Agent Runtime.
fn verify_extracted_skill(bytes: &[u8], root: &Path) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| format!("open cached Skill ZIP: {error}"))?;
    let mut expected = HashSet::new();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("read cached Skill ZIP: {error}"))?;
        if entry.is_dir() {
            continue;
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("cached Skill ZIP contains a symbolic link".into());
        }
        let relative = entry
            .enclosed_name()
            .ok_or("unsafe path in cached Skill ZIP")?
            .to_path_buf();
        let installed = std::fs::read(root.join(&relative)).map_err(|error| {
            format!("read installed Skill file {}: {error}", relative.display())
        })?;
        let mut packaged = Vec::with_capacity(entry.size() as usize);
        std::io::Read::read_to_end(&mut entry, &mut packaged)
            .map_err(|error| format!("read cached Skill file {}: {error}", relative.display()))?;
        if installed != packaged {
            return Err(format!(
                "installed Skill file was modified: {}",
                relative.display()
            ));
        }
        expected.insert(relative);
    }
    let mut actual = HashSet::new();
    collect_installed_files(root, root, &mut actual)?;
    if actual != expected {
        return Err("installed Skill file set differs from its signed package".into());
    }
    Ok(())
}

fn cache_skill_package(bytes: &[u8], skill_id: &str, version_id: &str) -> Result<PathBuf, String> {
    Uuid::parse_str(skill_id).map_err(|_| "invalid Skill id from organization server")?;
    Uuid::parse_str(version_id).map_err(|_| "invalid Skill version id from organization server")?;
    let path = organization_skills_root()
        .join(".packages")
        .join(skill_id)
        .join(format!("{version_id}.zip"));
    crate::paths::write_private_file(&path, bytes)?;
    Ok(path)
}

fn extract_skill_package(
    bytes: &[u8],
    skill_id: &str,
    version_id: &str,
) -> Result<PathBuf, String> {
    Uuid::parse_str(skill_id).map_err(|_| "invalid Skill id from organization server")?;
    Uuid::parse_str(version_id).map_err(|_| "invalid Skill version id from organization server")?;
    let root = organization_skills_root().join(skill_id);
    let final_dir = root.join(version_id);
    if final_dir.join("SKILL.md").is_file() {
        verify_extracted_skill(bytes, &final_dir)?;
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

fn pinned_signing_key() -> Result<VerifyingKey, String> {
    let profile = read_json::<OrgProfile>(&profile_path())?;
    let text = credential_read(&signing_key_account(&profile))?
        .ok_or("organization signing key is not pinned")?;
    decode_public_key(&text)
}

fn validate_skill_state(state: &SkillSyncState) -> Result<(), String> {
    if state.installed.is_empty() {
        return Ok(());
    }
    let key = pinned_signing_key()?;
    for item in state.installed.values() {
        verify_installed_skill(&key, item)?;
    }
    Ok(())
}

fn write_runtime_skill_config(state: &SkillSyncState) -> Result<(), String> {
    // Sidecar 和 config.toml 都属于用户可编辑文件。每次注入 Runtime
    // 前重新验证服务端签名，不信任 sidecar 里的 mandatory/覆盖值。
    validate_skill_state(state)?;
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
    let installed = state.installed.values().cloned().collect::<Vec<_>>();
    state.installed.clear();
    state.cursor.clear();
    state.lease_until = 0;
    write_runtime_skill_config(&state)?;
    write_json_private(&skill_state_path(), &state)?;
    for item in &installed {
        remove_installed_package(item);
    }
    Ok(())
}

pub fn enforce_skill_lease() {
    let mut state = read_json::<SkillSyncState>(&skill_state_path()).unwrap_or_default();
    let mut removed = Vec::new();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    if validate_skill_state(&state).is_err() {
        tracing::error!(
            "managed Skill sidecar signature validation failed; disabling managed Skills"
        );
        removed.extend(state.installed.values().cloned());
        state.installed.clear();
        state.cursor.clear();
        state.lease_until = 0;
    } else if state.lease_until > 0 && state.lease_until < now {
        removed.extend(state.installed.values().cloned());
        state.installed.clear();
        // 租约过期后下次联网必须全量同步。保留旧 cursor 会让服务端
        // 返回空增量，导致已暂停的 Skill 永远无法恢复。
        state.cursor.clear();
        state.lease_until = 0;
    }
    // 即使租约未过期也覆写 config.toml，这会在每次 Agent 会话
    // 前恢复签名策略，本地手工删除强制项不能持续生效。
    if let Err(error) = write_runtime_skill_config(&state) {
        tracing::warn!(%error, "failed to enforce managed Skill runtime config");
    }
    if let Err(error) = write_json_private(&skill_state_path(), &state) {
        tracing::warn!(%error, "failed to persist managed Skill lease state");
    }
    for item in &removed {
        remove_installed_package(item);
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
    // Sidecar 状态仍当作不可信输入：只删除
    // skills/organization/<uuid>/<uuid> 受管根下的精确版本。
    if Uuid::parse_str(&item.skill_id).is_err() || Uuid::parse_str(&item.version_id).is_err() {
        tracing::warn!(skill_id = %item.skill_id, version_id = %item.version_id, "refused unsafe managed Skill cleanup path");
        return;
    }
    let family_dir = organization_skills_root().join(&item.skill_id);
    let version_dir = family_dir.join(&item.version_id);
    if let Err(error) = std::fs::remove_dir_all(&version_dir) {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(%error, path = %version_dir.display(), "failed to remove revoked managed Skill package");
        }
    }
    let _ = std::fs::remove_dir(&family_dir);
    let cached = organization_skills_root()
        .join(".packages")
        .join(&item.skill_id)
        .join(format!("{}.zip", item.version_id));
    if let Err(error) = std::fs::remove_file(&cached) {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(%error, path = %cached.display(), "failed to remove revoked managed Skill cache");
        }
    }
}

async fn sync_skills(inner: &Arc<OrgInner>) -> Result<Value, String> {
    let mut local = read_json::<SkillSyncState>(&skill_state_path()).unwrap_or_default();
    if validate_skill_state(&local).is_err() {
        tracing::warn!("discarding invalid managed Skill sidecar and forcing a full sync");
        let invalid = local.installed.values().cloned().collect::<Vec<_>>();
        local = SkillSyncState::default();
        write_runtime_skill_config(&local)?;
        write_json_private(&skill_state_path(), &local)?;
        for item in &invalid {
            remove_installed_package(item);
        }
    }
    let path = format!(
        "/api/v1/skills/sync?cursor={}",
        urlencoding::encode(&local.cursor)
    );
    let data = authenticated_json(inner, Method::GET, &path, None).await?;
    let bootstrap = update_bootstrap(inner).await?;
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
        let response = authenticated_response(inner, Method::GET, package_url, None).await?;
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
        let package_path = cache_skill_package(&bytes, skill_id, version_id)?;
        let install_path = extract_skill_package(&bytes, skill_id, version_id)?;
        let installed = InstalledSkill {
            skill_id: skill_id.to_string(),
            version_id: version_id.to_string(),
            version: item
                .get("version")
                .and_then(Value::as_str)
                .ok_or("Skill item missing version")?
                .to_string(),
            name: item
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(skill_id)
                .to_string(),
            path: install_path.to_string_lossy().into_owned(),
            package_path: package_path.to_string_lossy().into_owned(),
            hash: item
                .get("hash")
                .and_then(Value::as_str)
                .ok_or("Skill item missing hash")?
                .to_string(),
            signature_payload: item
                .get("signaturePayload")
                .and_then(Value::as_str)
                .ok_or("Skill item missing signature payload")?
                .to_string(),
            signature: item
                .get("signature")
                .and_then(Value::as_str)
                .ok_or("Skill item missing signature")?
                .to_string(),
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

#[tauri::command]
pub async fn org_sync_skills(app: AppHandle, state: State<'_, OrgState>) -> Result<Value, String> {
    let result = sync_skills(&state.inner).await;
    notify_skills_changed(&app, "manual-sync");
    result
}

/// 应用启动后立即尝试恢复会话并同步，之后定时轮询。
/// 无登录/离线是正常状态，只记录 debug；租约到期由独立门禁处理。
pub fn start_background_sync(app: AppHandle) {
    let state = shared_state();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(5 * 60));
        loop {
            interval.tick().await;
            let has_profile = state.inner.session.lock().await.profile.is_some();
            if !has_profile {
                continue;
            }
            if let Err(error) = update_bootstrap(&state.inner).await {
                tracing::debug!(%error, "organization bootstrap refresh skipped");
                enforce_skill_lease();
                notify_skills_changed(&app, "lease-check");
                continue;
            }
            if let Err(error) = sync_skills(&state.inner).await {
                tracing::warn!(%error, "periodic managed Skill sync failed");
                enforce_skill_lease();
                notify_skills_changed(&app, "lease-check");
            } else {
                notify_skills_changed(&app, "background-sync");
            }
        }
    });
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
        assert!(normalize_server_url("https://10.132.19.82:8787/").is_ok());
        assert!(normalize_server_url("http://127.0.0.1:8787").is_ok());
        assert!(normalize_server_url("http://memory.example.com").is_err());
        assert!(normalize_server_url("https://u:p@memory.example.com").is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_dpapi_round_trip_uses_current_user() {
        let plaintext = "EchoAgent 组织凭据 \0 🔐".as_bytes();
        let encrypted = dpapi_protect(plaintext).unwrap();

        assert_ne!(encrypted, plaintext);
        assert_eq!(dpapi_unprotect(&encrypted).unwrap(), plaintext);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_dpapi_rejects_corrupt_ciphertext() {
        let error = dpapi_unprotect(b"not-a-dpapi-blob").unwrap_err();

        assert!(error.starts_with("DPAPI decryption failed:"));
    }

    #[test]
    fn document_fetch_body_omits_missing_page() {
        assert_eq!(
            document_fetch_body("doc-1".into(), None),
            json!({ "docId": "doc-1" })
        );
        assert_eq!(
            document_fetch_body("doc-1".into(), Some(3)),
            json!({ "docId": "doc-1", "page": 3 })
        );
    }

    #[test]
    fn sse_parser_preserves_unicode_split_between_network_chunks() {
        let frame = "event: delta\ndata: {\"text\":\"组织\"}\n\n";
        let mut pending = Vec::new();
        let mut events = Vec::new();
        for chunk in frame.as_bytes().chunks(2) {
            pending.extend_from_slice(chunk);
            events.extend(drain_sse_events(&mut pending).unwrap());
        }
        assert!(pending.is_empty());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "delta");
        assert_eq!(events[0].1, json!({ "text": "组织" }));
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
            ..Default::default()
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

    #[test]
    fn extracted_managed_skill_must_exactly_match_signed_zip() {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file("SKILL.md", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer
            .write_all(b"---\nname: verified\nversion: 1.0.0\n---\n")
            .unwrap();
        writer
            .start_file(
                "references/policy.md",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        writer.write_all(b"approved policy").unwrap();
        let package = writer.finish().unwrap().into_inner();

        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("references")).unwrap();
        std::fs::write(
            temp.path().join("SKILL.md"),
            b"---\nname: verified\nversion: 1.0.0\n---\n",
        )
        .unwrap();
        std::fs::write(temp.path().join("references/policy.md"), b"approved policy").unwrap();
        assert!(verify_extracted_skill(&package, temp.path()).is_ok());

        std::fs::write(temp.path().join("SKILL.md"), b"tampered instructions").unwrap();
        assert!(verify_extracted_skill(&package, temp.path()).is_err());
        std::fs::write(
            temp.path().join("SKILL.md"),
            b"---\nname: verified\nversion: 1.0.0\n---\n",
        )
        .unwrap();
        std::fs::write(temp.path().join("hidden.sh"), b"echo hidden").unwrap();
        assert!(verify_extracted_skill(&package, temp.path()).is_err());
    }
}
