//! Persisted WebDAV storage providers and backend I/O.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use fs2::FileExt;
use futures::StreamExt;
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;

const PROPFIND_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:"><D:prop><D:displayname/><D:resourcetype/>
<D:getcontentlength/><D:getlastmodified/><D:getcontenttype/></D:prop></D:propfind>"#;
const MAX_ERROR_BODY_BYTES: usize = 64 * 1024;
const MAX_PROPFIND_BODY_BYTES: usize = 5 * 1024 * 1024;
const MAX_TEXT_BODY_BYTES: usize = 5 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;
const MAX_UPLOAD_BYTES: u64 = 512 * 1024 * 1024;
const MAX_STORAGE_CONFIG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_STORAGE_PROVIDERS: usize = 64;
const MAX_REMOTE_PATH_CHARS: usize = 4_096;
const MAX_REMOTE_PATH_SEGMENTS: usize = 256;
const MAX_PROPFIND_ENTRIES: usize = 5_000;
const MAX_LOCAL_PATH_CHARS: usize = 32_768;
const STORAGE_LOCK_ATTEMPTS: usize = 200;
const STORAGE_LOCK_RETRY_DELAY: Duration = Duration::from_millis(10);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageProviderConfig {
    pub id: String,
    pub label: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    pub base_url: String,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    pub enabled: bool,
}

fn default_kind() -> String {
    "webdav".into()
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct StorageConfigStore {
    #[serde(default)]
    providers: Vec<StorageProviderConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StorageEntry {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub modified_at: Option<i64>,
    #[serde(default)]
    pub mime_type: Option<String>,
}

#[derive(Default)]
struct DavResponse {
    href: String,
    display_name: String,
    is_dir: bool,
    size: Option<u64>,
    modified_at: Option<i64>,
    mime_type: Option<String>,
}

static ACCESS: OnceLock<Mutex<()>> = OnceLock::new();
fn access() -> &'static Mutex<()> {
    ACCESS.get_or_init(|| Mutex::new(()))
}

fn config_path() -> PathBuf {
    crate::paths::echo_agent_home_dir().join("echoagent-storage-providers.json")
}

fn store_lock_path(path: &Path) -> PathBuf {
    let mut lock_path = path.as_os_str().to_os_string();
    lock_path.push(".lock");
    PathBuf::from(lock_path)
}

fn acquire_store_file_lock_at(path: &Path) -> Result<std::fs::File, String> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    match std::fs::symlink_metadata(parent) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("存储源配置目录必须是真实目录，不能是符号链接".into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("创建存储源配置目录失败：{error}"))?;
            let metadata = std::fs::symlink_metadata(parent)
                .map_err(|error| format!("检查存储源配置目录失败：{error}"))?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err("存储源配置目录必须是真实目录，不能是符号链接".into());
            }
        }
        Err(error) => return Err(format!("检查存储源配置目录失败：{error}")),
    }

    let lock_path = store_lock_path(path);
    match std::fs::symlink_metadata(&lock_path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err("存储源配置锁必须是普通文件，不能是符号链接".into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("检查存储源配置锁失败：{error}")),
    }

    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    options
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    #[cfg(windows)]
    options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    let file = options
        .open(&lock_path)
        .map_err(|error| format!("打开存储源配置锁失败：{error}"))?;
    if !file
        .metadata()
        .map_err(|error| format!("读取存储源配置锁失败：{error}"))?
        .is_file()
    {
        return Err("存储源配置锁在打开期间被替换".into());
    }

    for _ in 0..STORAGE_LOCK_ATTEMPTS {
        match FileExt::try_lock_exclusive(&file) {
            Ok(()) => return Ok(file),
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.raw_os_error() == fs2::lock_contended_error().raw_os_error() =>
            {
                std::thread::sleep(STORAGE_LOCK_RETRY_DELAY);
            }
            Err(error) => return Err(format!("锁定存储源配置失败：{error}")),
        }
    }
    Err("等待其他 EchoAgent 实例保存存储源配置超时，请稍后重试".into())
}

/// Serialize every operation that may quarantine or replace the provider
/// store. The fixed process-lock -> file-lock order prevents nested deadlocks,
/// while the separate stable lock pathname survives atomic store replacement.
fn with_store_access_at<T>(
    path: &Path,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _process_guard = access()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _file_guard = acquire_store_file_lock_at(path)?;
    operation()
}

fn quarantine_invalid_store(path: &std::path::Path) {
    let backup = path.with_extension(format!("json.corrupt.{}", uuid::Uuid::now_v7().simple()));
    if let Err(error) = std::fs::rename(path, &backup) {
        tracing::warn!(path = %path.display(), %error, "failed to quarantine invalid storage provider config");
    } else {
        let _ = crate::paths::harden_private_file(&backup);
        tracing::warn!(path = %path.display(), backup = %backup.display(), "invalid storage provider config was quarantined");
    }
}

fn read_store_at(path: &Path) -> Result<StorageConfigStore, String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(StorageConfigStore::default());
        }
        Err(error) => return Err(format!("读取存储源配置失败：{error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("存储源配置必须是普通文件，不能是符号链接".into());
    }
    if metadata.len() > MAX_STORAGE_CONFIG_BYTES {
        quarantine_invalid_store(path);
        return Err("存储源配置超过 2MB 限制，已隔离保存".into());
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    #[cfg(windows)]
    options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    let file = options
        .open(path)
        .map_err(|error| format!("打开存储源配置失败：{error}"))?;
    let mut raw = Vec::new();
    if file
        .take(MAX_STORAGE_CONFIG_BYTES.saturating_add(1))
        .read_to_end(&mut raw)
        .is_err()
        || raw.len() as u64 > MAX_STORAGE_CONFIG_BYTES
    {
        tracing::warn!("storage provider config is unreadable or exceeds 2MB");
        quarantine_invalid_store(path);
        return Err("存储源配置无法读取或超过 2MB，已隔离保存".into());
    }
    match serde_json::from_slice(&raw) {
        Ok(store) => {
            let store: StorageConfigStore = store;
            if store.providers.len() > MAX_STORAGE_PROVIDERS
                || store
                    .providers
                    .iter()
                    .any(|provider| validate_shape(provider).is_err())
            {
                quarantine_invalid_store(path);
                return Err("存储源配置包含超限或不安全条目，已隔离保存".into());
            }
            Ok(store)
        }
        Err(error) => {
            tracing::warn!(%error, "storage provider config is invalid JSON");
            quarantine_invalid_store(path);
            Err("存储源配置 JSON 损坏，已隔离保存".into())
        }
    }
}

fn read_store() -> Result<StorageConfigStore, String> {
    let path = config_path();
    with_store_access_at(&path, || read_store_at(&path))
}

fn write_store_at(path: &Path, store: &StorageConfigStore) -> Result<(), String> {
    if store.providers.len() > MAX_STORAGE_PROVIDERS
        || store
            .providers
            .iter()
            .any(|provider| validate_shape(provider).is_err())
    {
        return Err("存储源配置包含超限或不安全条目，未写入磁盘".into());
    }
    let raw = serde_json::to_vec_pretty(store)
        .map_err(|e| format!("serialize storage providers: {e}"))?;
    if raw.len() as u64 > MAX_STORAGE_CONFIG_BYTES {
        return Err("存储源配置超过 2MB 限制，未写入磁盘".into());
    }
    crate::paths::write_private_file(path, &raw)
}

fn update_store_at<T>(
    path: &Path,
    update: impl FnOnce(&mut StorageConfigStore) -> Result<T, String>,
) -> Result<T, String> {
    with_store_access_at(path, || {
        let mut store = read_store_at(path)?;
        let result = update(&mut store)?;
        write_store_at(path, &store)?;
        Ok(result)
    })
}

fn validate_shape(config: &StorageProviderConfig) -> Result<(), String> {
    if config.id.trim().is_empty()
        || config.id.len() > 128
        || config.id.chars().any(char::is_control)
        || config.label.trim().is_empty()
        || config.label.len() > 512
        || config.label.chars().any(char::is_control)
        || config
            .username
            .as_ref()
            .is_some_and(|value| value.len() > 4096 || value.contains('\0'))
        || config
            .password
            .as_ref()
            .is_some_and(|value| value.len() > 64 * 1024 || value.contains('\0'))
    {
        return Err("存储源 id 和显示名不能为空".into());
    }
    if config.kind != "webdav" {
        return Err("当前版本仅支持 WebDAV".into());
    }
    if config.base_url.chars().count() > 8_192 || config.base_url.chars().any(char::is_control) {
        return Err("WebDAV URL 过长或包含控制字符".into());
    }
    Ok(())
}

fn validate(config: &StorageProviderConfig) -> Result<(), String> {
    validate_shape(config)?;
    let url = url::Url::parse(&config.base_url).map_err(|e| format!("WebDAV URL 无效：{e}"))?;
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("WebDAV URL 缺少主机或包含内嵌凭据、query/fragment".into());
    }
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("WebDAV URL 必须使用 http 或 https".into());
    }
    let loopback = url.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host == "127.0.0.1"
            || host.trim_matches(['[', ']']) == "::1"
    });
    if url.scheme() != "https" && !loopback {
        return Err("WebDAV 凭据只能通过 HTTPS 传输（本机 localhost/回环地址除外）".into());
    }
    Ok(())
}

fn provider(id: &str) -> Result<StorageProviderConfig, String> {
    let config = read_store()?
        .providers
        .into_iter()
        .find(|p| p.id == id && p.enabled)
        .ok_or_else(|| format!("存储源 {id} 不存在或未启用"))?;
    // Revalidate persisted entries at the point of use. Older releases allowed
    // remote plaintext HTTP, so validating only new writes would still send a
    // saved Basic credential over an insecure legacy endpoint.
    validate(&config).map_err(|error| format!("存储源 {id} 配置不安全：{error}"))?;
    Ok(config)
}

fn target_url(config: &StorageProviderConfig, path: &str) -> Result<url::Url, String> {
    let path = normalize_path(path)?;
    let mut url = url::Url::parse(config.base_url.trim_end_matches('/'))
        .map_err(|e| format!("WebDAV URL 无效：{e}"))?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "WebDAV URL 不能作为目录 URL")?;
        segments.pop_if_empty();
        for segment in path.trim_matches('/').split('/').filter(|s| !s.is_empty()) {
            segments.push(segment);
        }
    }
    Ok(url)
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        // A configured WebDAV origin is credential-bearing. Do not replay
        // Basic auth or write methods through redirects to a different target.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("HTTP client: {e}"))
}

fn request(
    config: &StorageProviderConfig,
    method: reqwest::Method,
    path: &str,
) -> Result<reqwest::RequestBuilder, String> {
    let mut request = client()?.request(method, target_url(config, path)?);
    if let Some(username) = config.username.as_deref().filter(|v| !v.is_empty()) {
        request = request.basic_auth(username, config.password.clone());
    }
    Ok(request)
}

fn confirm_file_transfer(app: &AppHandle, title: &str, message: String) -> Result<(), String> {
    let approved = app
        .dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "允许本次".into(),
            "取消".into(),
        ))
        .blocking_show();
    if approved {
        Ok(())
    } else {
        Err("用户取消了文件传输".into())
    }
}

async fn response_prefix(
    response: reqwest::Response,
    limit: usize,
) -> Result<(Vec<u8>, bool), String> {
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::with_capacity(limit.min(64 * 1024));
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("读取响应失败：{error}"))?;
        let remaining = limit.saturating_add(1).saturating_sub(bytes.len());
        if remaining == 0 {
            return Ok((bytes, true));
        }
        bytes.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        if bytes.len() > limit {
            bytes.truncate(limit);
            return Ok((bytes, true));
        }
    }
    Ok((bytes, false))
}

async fn response_bytes_limited(
    response: reqwest::Response,
    limit: usize,
    label: &str,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(format!("{label}超过 {}MB 限制", limit / 1024 / 1024));
    }
    let (bytes, truncated) = response_prefix(response, limit).await?;
    if truncated {
        Err(format!("{label}超过 {}MB 限制", limit / 1024 / 1024))
    } else {
        Ok(bytes)
    }
}

async fn response_error(response: reqwest::Response, operation: &str) -> String {
    let status = response.status();
    let (detail, truncated) = response_prefix(response, MAX_ERROR_BODY_BYTES)
        .await
        .unwrap_or_default();
    let detail = String::from_utf8_lossy(&detail);
    let suffix = if truncated { "…" } else { "" };
    format!(
        "{operation} 失败：HTTP {status} {}{suffix}",
        detail.chars().take(240).collect::<String>(),
    )
}

fn decode_href_path(href: &str) -> String {
    let raw_path = url::Url::parse(href)
        .map(|u| u.path().to_string())
        .unwrap_or_else(|_| href.split('?').next().unwrap_or(href).to_string());
    urlencoding::decode(&raw_path)
        .map(|v| v.into_owned())
        .unwrap_or(raw_path)
}

fn parse_propfind(
    xml: &str,
    config: &StorageProviderConfig,
    requested_path: &str,
) -> Result<Vec<StorageEntry>, String> {
    let base_path = url::Url::parse(&config.base_url)
        .ok()
        .map(|u| decode_href_path(u.path()))
        .unwrap_or_default();
    let base_path = normalize_path(&base_path)?;
    let base_prefix = format!("{}/", base_path.trim_end_matches('/'));
    let requested = normalize_path(requested_path)?;
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut current: Option<DavResponse> = None;
    let mut field = String::new();
    let mut out = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) => {
                let name =
                    String::from_utf8_lossy(event.local_name().as_ref()).to_ascii_lowercase();
                if name == "response" {
                    current = Some(DavResponse::default());
                }
                field = name;
            }
            Ok(Event::Empty(event)) => {
                let name =
                    String::from_utf8_lossy(event.local_name().as_ref()).to_ascii_lowercase();
                if name == "collection" {
                    if let Some(item) = &mut current {
                        item.is_dir = true;
                    }
                }
            }
            Ok(Event::Text(text)) => {
                let value = text.decode().map(|v| v.into_owned()).unwrap_or_default();
                if let Some(item) = &mut current {
                    match field.as_str() {
                        "href" => item.href = value,
                        "displayname" => item.display_name = value,
                        "getcontentlength" => item.size = value.parse().ok(),
                        "getlastmodified" => {
                            item.modified_at = chrono::DateTime::parse_from_rfc2822(&value)
                                .ok()
                                .map(|v| v.timestamp_millis())
                        }
                        "getcontenttype" => item.mime_type = (!value.is_empty()).then_some(value),
                        _ => {}
                    }
                }
            }
            Ok(Event::End(event)) => {
                let name =
                    String::from_utf8_lossy(event.local_name().as_ref()).to_ascii_lowercase();
                if name == "response" {
                    if let Some(item) = current.take() {
                        let Ok(href_path) = normalize_path(&decode_href_path(&item.href)) else {
                            field.clear();
                            continue;
                        };
                        let relative = if base_path == "/" {
                            href_path.as_str()
                        } else if href_path == base_path {
                            "/"
                        } else if let Some(relative) = href_path.strip_prefix(&base_prefix) {
                            relative
                        } else {
                            // A DAV response must not inject entries outside the configured
                            // collection. Besides confusing the UI, accepting one would turn
                            // a later click into an operation on a different server-side path.
                            field.clear();
                            continue;
                        };
                        let Ok(path) = normalize_path(relative) else {
                            field.clear();
                            continue;
                        };
                        if path != requested {
                            let fallback_name = path
                                .trim_end_matches('/')
                                .split('/')
                                .next_back()
                                .unwrap_or_default();
                            let display_name = if item.display_name.trim().is_empty() {
                                fallback_name.to_string()
                            } else {
                                item.display_name
                                    .trim()
                                    .chars()
                                    .filter(|character| !character.is_control())
                                    .collect()
                            };
                            if !display_name.is_empty() {
                                if out.len() >= MAX_PROPFIND_ENTRIES {
                                    return Err(format!(
                                        "WebDAV 目录条目超过 {MAX_PROPFIND_ENTRIES} 条限制"
                                    ));
                                }
                                out.push(StorageEntry {
                                    path,
                                    name: display_name.chars().take(512).collect(),
                                    is_dir: item.is_dir,
                                    size: item.size,
                                    modified_at: item.modified_at,
                                    mime_type: item.mime_type.map(|mime_type| {
                                        mime_type
                                            .chars()
                                            .filter(|character| !character.is_control())
                                            .take(512)
                                            .collect()
                                    }),
                                });
                            }
                        }
                    }
                }
                field.clear();
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(format!("WebDAV PROPFIND XML 无效：{error}")),
            _ => {}
        }
    }
    Ok(out)
}

fn normalize_path(path: &str) -> Result<String, String> {
    if path.chars().count() > MAX_REMOTE_PATH_CHARS
        || path
            .chars()
            .any(|character| character == '\0' || character.is_control())
    {
        return Err("远程路径过长或包含控制字符".into());
    }
    let normalized = path.replace('\\', "/");
    let raw_parts = normalized.split('/').filter(|part| !part.is_empty());
    let mut parts = Vec::new();
    for part in raw_parts {
        if part == "." {
            continue;
        }
        if part == ".." {
            return Err("远程路径不能包含 .. 段".into());
        }
        if part.chars().count() > 512 {
            return Err("远程路径段过长".into());
        }
        if parts.len() >= MAX_REMOTE_PATH_SEGMENTS {
            return Err("远程路径层级过深".into());
        }
        parts.push(part.to_string());
    }
    if parts.is_empty() {
        Ok("/".into())
    } else {
        Ok(format!("/{}", parts.join("/")))
    }
}

fn normalize_mutation_path(path: &str) -> Result<String, String> {
    let path = normalize_path(path)?;
    if path == "/" {
        Err("不允许对 WebDAV 根目录执行此操作".into())
    } else {
        Ok(path)
    }
}

fn checked_local_path(path: &str, label: &str) -> Result<PathBuf, String> {
    if path.chars().count() > MAX_LOCAL_PATH_CHARS
        || path
            .chars()
            .any(|character| character == '\0' || character.is_control())
    {
        return Err(format!("{label}路径过长或包含控制字符"));
    }
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(format!("{label}路径必须是绝对路径"));
    }
    Ok(path)
}

/// Open the exact upload object without following a final symlink, then keep
/// that handle alive through confirmation and streaming. This closes the
/// check/open race where a selected regular file could otherwise be replaced
/// with a link to a different local file after the user approved the upload.
fn open_upload_source(source: &std::path::Path) -> Result<(std::fs::File, u64), String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    #[cfg(windows)]
    options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    let file = options
        .open(source)
        .map_err(|error| format!("打开上传文件失败：{error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("读取上传文件失败：{error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("上传源必须是普通文件，不能是符号链接".into());
    }
    if metadata.len() > MAX_UPLOAD_BYTES {
        return Err("上传文件超过 512MB 限制".into());
    }
    Ok((file, metadata.len()))
}

#[tauri::command]
pub fn storage_providers_list() -> Result<Vec<StorageProviderConfig>, String> {
    Ok(read_store()?
        .providers
        .into_iter()
        .map(|mut p| {
            if p.password.as_deref().is_some_and(|v| !v.is_empty()) {
                p.password = Some("••••".into());
            }
            p
        })
        .collect())
}

fn apply_provider_upsert(
    store: &mut StorageConfigStore,
    mut config: StorageProviderConfig,
) -> Result<(), String> {
    if let Some(existing) = store.providers.iter_mut().find(|p| p.id == config.id) {
        if config.password.as_deref() == Some("••••") {
            config.password = existing.password.clone();
        }
        *existing = config;
    } else {
        if store.providers.len() >= MAX_STORAGE_PROVIDERS {
            return Err(format!("存储源数量超过 {MAX_STORAGE_PROVIDERS} 个的上限"));
        }
        if config.password.as_deref() == Some("••••") {
            return Err("新存储源不能使用密码掩码，请重新输入密码".into());
        }
        store.providers.push(config);
    }
    Ok(())
}

fn upsert_provider_at(path: &Path, config: StorageProviderConfig) -> Result<(), String> {
    validate(&config)?;
    update_store_at(path, move |store| apply_provider_upsert(store, config))
}

fn remove_provider_at(path: &Path, id: &str) -> Result<(), String> {
    update_store_at(path, |store| {
        store.providers.retain(|provider| provider.id != id);
        Ok(())
    })
}

#[tauri::command]
pub fn storage_provider_upsert(config: StorageProviderConfig) -> Result<(), String> {
    crate::policy::require_feature("cloud-storage")?;
    upsert_provider_at(&config_path(), config)
}

#[tauri::command]
pub fn storage_provider_remove(id: String) -> Result<(), String> {
    crate::policy::require_feature("cloud-storage")?;
    remove_provider_at(&config_path(), &id)
}

async fn propfind(
    config: &StorageProviderConfig,
    path: &str,
    depth: &str,
) -> Result<reqwest::Response, String> {
    let method = reqwest::Method::from_bytes(b"PROPFIND").unwrap();
    request(config, method, path)?
        .header("Depth", depth)
        .header("Content-Type", "application/xml; charset=utf-8")
        .body(PROPFIND_BODY)
        .send()
        .await
        .map_err(|e| format!("WebDAV 连接失败：{e}"))
}

#[tauri::command]
pub async fn storage_provider_test(id: String) -> Result<(), String> {
    crate::policy::require_feature("cloud-storage")?;
    let config = provider(&id)?;
    let response = propfind(&config, "/", "0").await?;
    if response.status().is_success() || response.status().as_u16() == 207 {
        Ok(())
    } else {
        Err(response_error(response, "连接测试").await)
    }
}

#[tauri::command]
pub async fn storage_list(id: String, path: String) -> Result<Vec<StorageEntry>, String> {
    crate::policy::require_feature("cloud-storage")?;
    let config = provider(&id)?;
    let path = normalize_path(&path)?;
    let response = propfind(&config, &path, "1").await?;
    if !(response.status().is_success() || response.status().as_u16() == 207) {
        return Err(response_error(response, "列出目录").await);
    }
    let xml = response_bytes_limited(response, MAX_PROPFIND_BODY_BYTES, "WebDAV 目录响应").await?;
    let xml = String::from_utf8(xml).map_err(|e| format!("WebDAV XML 不是有效 UTF-8：{e}"))?;
    parse_propfind(&xml, &config, &path)
}

#[tauri::command]
pub async fn storage_read_text(id: String, path: String) -> Result<String, String> {
    crate::policy::require_feature("cloud-storage")?;
    let config = provider(&id)?;
    let path = normalize_path(&path)?;
    let response = request(&config, reqwest::Method::GET, &path)?
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(response_error(response, "读取文件").await);
    }
    let bytes = response_bytes_limited(response, MAX_TEXT_BODY_BYTES, "文本文件").await?;
    String::from_utf8(bytes).map_err(|e| format!("文件不是有效 UTF-8 文本：{e}"))
}

#[tauri::command]
pub async fn storage_write_text(id: String, path: String, content: String) -> Result<(), String> {
    crate::policy::require_feature("cloud-storage")?;
    let config = provider(&id)?;
    if content.len() > MAX_TEXT_BODY_BYTES {
        return Err("文本内容超过 5MB 限制".into());
    }
    let path = normalize_mutation_path(&path)?;
    let response = request(&config, reqwest::Method::PUT, &path)?
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(content)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(response_error(response, "写入文件").await)
    }
}

#[tauri::command]
pub async fn storage_upload_file(
    app: AppHandle,
    id: String,
    path: String,
    local_path: String,
) -> Result<u64, String> {
    crate::policy::require_feature("cloud-storage")?;
    let config = provider(&id)?;
    let path = normalize_mutation_path(&path)?;
    let source = checked_local_path(&local_path, "上传源")?;
    let source_for_open = source.clone();
    let (file, size) =
        tauri::async_runtime::spawn_blocking(move || open_upload_source(&source_for_open))
            .await
            .map_err(|error| format!("打开上传文件的任务失败：{error}"))??;
    confirm_file_transfer(
        &app,
        "允许上传本地文件？",
        format!(
            "EchoAgent 将读取本地文件并上传到存储源。\n\n本地：{}\n远程：{}",
            source.display(),
            path
        ),
    )?;
    let file = tokio::fs::File::from_std(file);
    let body = reqwest::Body::wrap_stream(ReaderStream::new(file));
    let response = request(&config, reqwest::Method::PUT, &path)?
        .header("Content-Type", "application/octet-stream")
        .header("Content-Length", size)
        .body(body)
        .send()
        .await
        .map_err(|e| format!("上传失败：{e}"))?;
    if response.status().is_success() {
        Ok(size)
    } else {
        Err(response_error(response, "上传文件").await)
    }
}

fn validate_download_destination(destination: &std::path::Path) -> Result<PathBuf, String> {
    let parent = destination
        .parent()
        .filter(|parent| parent.is_dir())
        .ok_or("下载目标的父目录不存在")?;
    let file_name = destination.file_name().ok_or("下载目标必须是文件路径")?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|error| format!("无法解析下载目录：{error}"))?;
    let destination = canonical_parent.join(file_name);
    match std::fs::symlink_metadata(&destination) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err("拒绝覆盖符号链接".into()),
        Ok(metadata) if !metadata.is_file() => Err("下载目标不是普通文件".into()),
        Ok(_) => Ok(destination),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(destination),
        Err(error) => Err(format!("无法检查下载目标：{error}")),
    }
}

#[tauri::command]
pub async fn storage_download_file(
    app: AppHandle,
    id: String,
    path: String,
    local_path: String,
) -> Result<u64, String> {
    crate::policy::require_feature("cloud-storage")?;
    let config = provider(&id)?;
    let path = normalize_path(&path)?;
    let requested_destination = checked_local_path(&local_path, "下载目标")?;
    let destination = validate_download_destination(&requested_destination)?;
    confirm_file_transfer(
        &app,
        "允许写入本地文件？",
        format!(
            "EchoAgent 将从存储源下载文件并写入以下位置：\n\n{}",
            destination.display()
        ),
    )?;
    let response = request(&config, reqwest::Method::GET, &path)?
        .send()
        .await
        .map_err(|e| format!("下载失败：{e}"))?;
    if !response.status().is_success() {
        return Err(response_error(response, "下载文件").await);
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_DOWNLOAD_BYTES)
    {
        return Err("下载文件超过 512MB 限制".into());
    }

    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download");
    let temp = destination.with_file_name(format!(
        ".{file_name}.echoagent-{}.part",
        uuid::Uuid::now_v7()
    ));
    let result = async {
        let mut output = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .await
            .map_err(|e| format!("创建下载文件失败：{e}"))?;
        let mut stream = response.bytes_stream();
        let mut written = 0_u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("接收下载数据失败：{e}"))?;
            if written.saturating_add(chunk.len() as u64) > MAX_DOWNLOAD_BYTES {
                return Err("下载文件超过 512MB 限制".into());
            }
            output
                .write_all(&chunk)
                .await
                .map_err(|e| format!("写入下载文件失败：{e}"))?;
            written += chunk.len() as u64;
        }
        output
            .flush()
            .await
            .map_err(|e| format!("刷新下载文件失败：{e}"))?;
        output
            .sync_all()
            .await
            .map_err(|e| format!("同步下载文件失败：{e}"))?;
        drop(output);
        // Re-check immediately before replacing an existing path. In
        // particular, never rename a symlink out of the way and replace the
        // pathname as if the user had selected a regular file.
        let revalidated = validate_download_destination(&requested_destination)?;
        if revalidated != destination {
            return Err("下载目录在传输期间发生变化，已取消写入".into());
        }
        crate::paths::replace_file_atomically(&temp, &destination)
            .map_err(|error| format!("保存下载文件失败：{error}"))?;
        Ok::<u64, String>(written)
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temp).await;
    }
    result
}

#[tauri::command]
pub async fn storage_delete(id: String, path: String) -> Result<(), String> {
    crate::policy::require_feature("cloud-storage")?;
    let config = provider(&id)?;
    let path = normalize_mutation_path(&path)?;
    let response = request(&config, reqwest::Method::DELETE, &path)?
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(response_error(response, "删除").await)
    }
}

#[tauri::command]
pub async fn storage_make_dir(id: String, path: String) -> Result<(), String> {
    crate::policy::require_feature("cloud-storage")?;
    let config = provider(&id)?;
    let path = normalize_mutation_path(&path)?;
    let method = reqwest::Method::from_bytes(b"MKCOL").unwrap();
    let response = request(&config, method, &path)?
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(response_error(response, "创建目录").await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_provider(id: &str) -> StorageProviderConfig {
        StorageProviderConfig {
            id: id.into(),
            label: format!("Provider {id}"),
            kind: "webdav".into(),
            base_url: format!("https://dav.test/{id}"),
            username: Some("user".into()),
            password: Some(format!("secret-{id}")),
            enabled: true,
        }
    }

    fn read_store_with_lock_at(path: &Path) -> StorageConfigStore {
        with_store_access_at(path, || read_store_at(path)).unwrap()
    }

    #[test]
    fn parses_namespace_independent_propfind() {
        let config = StorageProviderConfig {
            id: "x".into(),
            label: "x".into(),
            kind: "webdav".into(),
            base_url: "https://dav.test/files/u".into(),
            username: None,
            password: None,
            enabled: true,
        };
        let xml = r#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/files/u/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response><d:response><d:href>/files/u/a%20b.txt</d:href><d:propstat><d:prop><d:displayname>a b.txt</d:displayname><d:getcontentlength>12</d:getcontentlength><d:getcontenttype>text/plain</d:getcontenttype></d:prop></d:propstat></d:response></d:multistatus>"#;
        let entries = parse_propfind(xml, &config, "/").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "/a b.txt");
        assert_eq!(entries[0].size, Some(12));
    }
    #[test]
    fn normalizes_safe_paths_and_rejects_traversal() {
        assert_eq!(normalize_path("/a//./b").unwrap(), "/a/b");
        assert_eq!(normalize_path("").unwrap(), "/");
        assert!(normalize_path("/a/../b").is_err());
        assert!(normalize_path("/a\n/b").is_err());
        assert!(normalize_mutation_path("/").is_err());
    }

    #[test]
    fn rejects_webdav_base_url_query_and_out_of_collection_entries() {
        let mut config = StorageProviderConfig {
            id: "x".into(),
            label: "x".into(),
            kind: "webdav".into(),
            base_url: "https://dav.test/files/u?secret=1".into(),
            username: None,
            password: None,
            enabled: true,
        };
        assert!(validate(&config).is_err());

        config.base_url = "https://dav.test/files/u".into();
        let xml = r#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/files/user2/escape.txt</d:href><d:propstat><d:prop><d:displayname>escape.txt</d:displayname></d:prop></d:propstat></d:response></d:multistatus>"#;
        assert!(parse_propfind(xml, &config, "/").unwrap().is_empty());
    }

    #[test]
    fn rejects_plain_http_for_remote_webdav_credentials() {
        let config = StorageProviderConfig {
            id: "remote".into(),
            label: "remote".into(),
            kind: "webdav".into(),
            base_url: "http://dav.example.com/files".into(),
            username: Some("user".into()),
            password: Some("secret".into()),
            enabled: true,
        };
        assert!(validate(&config).is_err());
    }

    #[test]
    fn allows_plain_http_for_loopback_development_server() {
        let config = StorageProviderConfig {
            id: "local".into(),
            label: "local".into(),
            kind: "webdav".into(),
            base_url: "http://127.0.0.1:1900/dav".into(),
            username: None,
            password: None,
            enabled: true,
        };
        assert!(validate(&config).is_ok());
    }

    #[test]
    fn storage_transaction_oversized_write_preserves_existing_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("providers.json");
        write_store_at(
            &path,
            &StorageConfigStore {
                providers: vec![test_provider("existing")],
            },
        )
        .unwrap();
        let original = std::fs::read(&path).unwrap();

        let error = update_store_at(&path, |store| {
            store.providers = (0..MAX_STORAGE_PROVIDERS)
                .map(|index| {
                    let mut provider = test_provider(&format!("large-{index}"));
                    provider.password = Some("x".repeat(40 * 1024));
                    provider
                })
                .collect();
            Ok(())
        })
        .unwrap_err();

        assert!(error.contains("2MB"), "unexpected error: {error}");
        assert_eq!(std::fs::read(&path).unwrap(), original);
    }

    #[test]
    fn storage_transaction_corrupt_file_is_quarantined_not_overwritten() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("providers.json");
        let corrupt = b"{ definitely not valid JSON";
        std::fs::write(&path, corrupt).unwrap();

        let error = upsert_provider_at(&path, test_provider("new")).unwrap_err();

        assert!(error.contains("JSON 损坏"), "unexpected error: {error}");
        assert!(
            !path.exists(),
            "mutation must not replace quarantined input"
        );
        let backups = std::fs::read_dir(temp.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("providers.json.corrupt.")
            })
            .collect::<Vec<_>>();
        assert_eq!(backups.len(), 1);
        assert_eq!(std::fs::read(backups[0].path()).unwrap(), corrupt);
    }

    #[cfg(unix)]
    #[test]
    fn storage_transaction_symlink_is_not_followed_or_overwritten() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("outside.json");
        let path = temp.path().join("providers.json");
        let outside = b"outside data must survive";
        std::fs::write(&target, outside).unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();

        let error = remove_provider_at(&path, "anything").unwrap_err();

        assert!(error.contains("符号链接"), "unexpected error: {error}");
        assert_eq!(std::fs::read(&target).unwrap(), outside);
        assert!(std::fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn storage_transaction_concurrent_upserts_and_removals_preserve_changes() {
        const CHANGES: usize = 8;
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("providers.json");
        let mut initial = vec![test_provider("keeper")];
        initial.extend((0..CHANGES).map(|index| test_provider(&format!("old-{index}"))));
        write_store_at(&path, &StorageConfigStore { providers: initial }).unwrap();

        let barrier = std::sync::Arc::new(std::sync::Barrier::new(CHANGES * 2));
        let mut handles = Vec::new();
        for index in 0..CHANGES {
            let path = path.clone();
            let barrier = barrier.clone();
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                upsert_provider_at(&path, test_provider(&format!("new-{index}")))
            }));
        }
        for index in 0..CHANGES {
            let path = path.clone();
            let barrier = barrier.clone();
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                remove_provider_at(&path, &format!("old-{index}"))
            }));
        }
        for handle in handles {
            handle.join().unwrap().unwrap();
        }

        let store = read_store_with_lock_at(&path);
        let ids = store
            .providers
            .iter()
            .map(|provider| provider.id.as_str())
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(ids.len(), CHANGES + 1);
        assert!(ids.contains("keeper"));
        for index in 0..CHANGES {
            assert!(ids.contains(format!("new-{index}").as_str()));
            assert!(!ids.contains(format!("old-{index}").as_str()));
        }
    }

    const CHILD_PATH_ENV: &str = "ECHOAGENT_STORAGE_TRANSACTION_CHILD_PATH";
    const CHILD_ID_ENV: &str = "ECHOAGENT_STORAGE_TRANSACTION_CHILD_ID";
    const CHILD_READY_ENV: &str = "ECHOAGENT_STORAGE_TRANSACTION_CHILD_READY";
    const CHILD_START_ENV: &str = "ECHOAGENT_STORAGE_TRANSACTION_CHILD_START";

    /// Invoked by `storage_transaction_cross_process_upserts_preserve_changes`
    /// through the Rust test harness. A normal test-suite invocation has no
    /// path environment variable and returns immediately.
    #[test]
    fn storage_transaction_child_writer() {
        let Some(path) = std::env::var_os(CHILD_PATH_ENV).map(PathBuf::from) else {
            return;
        };
        let id = std::env::var(CHILD_ID_ENV).expect("child id");
        let ready = PathBuf::from(std::env::var_os(CHILD_READY_ENV).expect("ready path"));
        let start = PathBuf::from(std::env::var_os(CHILD_START_ENV).expect("start path"));
        std::fs::write(&ready, b"ready").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !start.exists() {
            assert!(
                std::time::Instant::now() < deadline,
                "start barrier timed out"
            );
            std::thread::sleep(Duration::from_millis(10));
        }

        let config = test_provider(&id);
        validate(&config).unwrap();
        update_store_at(&path, move |store| {
            // Deterministically widens the stale-snapshot window. The file
            // lock keeps other processes outside the transaction during it.
            std::thread::sleep(Duration::from_millis(100));
            apply_provider_upsert(store, config)
        })
        .unwrap();
    }

    #[test]
    fn storage_transaction_cross_process_upserts_preserve_changes() {
        const CHILDREN: usize = 4;
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("providers.json");
        let start = temp.path().join("start");
        write_store_at(
            &path,
            &StorageConfigStore {
                providers: vec![test_provider("keeper")],
            },
        )
        .unwrap();

        let test_binary = std::env::current_exe().unwrap();
        let mut children = Vec::new();
        let mut ready_paths = Vec::new();
        for index in 0..CHILDREN {
            let ready = temp.path().join(format!("ready-{index}"));
            let child = std::process::Command::new(&test_binary)
                .arg("--exact")
                .arg("storage::tests::storage_transaction_child_writer")
                .arg("--nocapture")
                .env(CHILD_PATH_ENV, &path)
                .env(CHILD_ID_ENV, format!("child-{index}"))
                .env(CHILD_READY_ENV, &ready)
                .env(CHILD_START_ENV, &start)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            children.push(child);
            ready_paths.push(ready);
        }

        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !ready_paths.iter().all(|ready| ready.exists()) {
            assert!(
                std::time::Instant::now() < deadline,
                "child readiness barrier timed out"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        std::fs::write(&start, b"start").unwrap();
        for child in children {
            let output = child.wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "child failed:\nstdout:\n{}\nstderr:\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }

        let store = read_store_with_lock_at(&path);
        assert_eq!(store.providers.len(), CHILDREN + 1);
        assert!(store
            .providers
            .iter()
            .any(|provider| provider.id == "keeper"));
        for index in 0..CHILDREN {
            assert!(store
                .providers
                .iter()
                .any(|provider| provider.id == format!("child-{index}")));
        }
    }
}
