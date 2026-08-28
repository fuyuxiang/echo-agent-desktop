//! Persisted WebDAV storage providers and backend I/O.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use futures::StreamExt;
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};

const PROPFIND_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:"><D:prop><D:displayname/><D:resourcetype/>
<D:getcontentlength/><D:getlastmodified/><D:getcontenttype/></D:prop></D:propfind>"#;

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

fn read_store() -> StorageConfigStore {
    let Ok(raw) = std::fs::read_to_string(config_path()) else {
        return StorageConfigStore::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_store(store: &StorageConfigStore) -> Result<(), String> {
    let raw = serde_json::to_vec_pretty(store)
        .map_err(|e| format!("serialize storage providers: {e}"))?;
    crate::paths::write_private_file(&config_path(), &raw)
}

fn validate(config: &StorageProviderConfig) -> Result<(), String> {
    if config.id.trim().is_empty() || config.label.trim().is_empty() {
        return Err("存储源 id 和显示名不能为空".into());
    }
    if config.kind != "webdav" {
        return Err("当前版本仅支持 WebDAV".into());
    }
    let url = url::Url::parse(&config.base_url).map_err(|e| format!("WebDAV URL 无效：{e}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("WebDAV URL 必须使用 http 或 https".into());
    }
    Ok(())
}

fn provider(id: &str) -> Result<StorageProviderConfig, String> {
    let _guard = access().lock().unwrap();
    read_store()
        .providers
        .into_iter()
        .find(|p| p.id == id && p.enabled)
        .ok_or_else(|| format!("存储源 {id} 不存在或未启用"))
}

fn target_url(config: &StorageProviderConfig, path: &str) -> Result<url::Url, String> {
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

async fn response_error(response: reqwest::Response, operation: &str) -> String {
    let status = response.status();
    let detail = response.text().await.unwrap_or_default();
    format!(
        "{operation} 失败：HTTP {status} {}",
        detail.chars().take(240).collect::<String>()
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
    let requested = normalize_path(requested_path);
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
                        let href_path = decode_href_path(&item.href);
                        let relative = href_path
                            .strip_prefix(base_path.trim_end_matches('/'))
                            .unwrap_or(&href_path);
                        let path = normalize_path(relative);
                        if path != requested {
                            let fallback_name = path
                                .trim_end_matches('/')
                                .split('/')
                                .next_back()
                                .unwrap_or_default();
                            let display_name = if item.display_name.trim().is_empty() {
                                fallback_name.to_string()
                            } else {
                                item.display_name.trim().to_string()
                            };
                            if !display_name.is_empty() {
                                out.push(StorageEntry {
                                    path,
                                    name: display_name,
                                    is_dir: item.is_dir,
                                    size: item.size,
                                    modified_at: item.modified_at,
                                    mime_type: item.mime_type,
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

fn normalize_path(path: &str) -> String {
    let parts = path
        .replace('\\', "/")
        .split('/')
        .filter(|part| !part.is_empty() && *part != "." && *part != "..")
        .map(str::to_string)
        .collect::<Vec<_>>();
    if parts.is_empty() {
        "/".into()
    } else {
        format!("/{}", parts.join("/"))
    }
}

#[tauri::command]
pub fn storage_providers_list() -> Vec<StorageProviderConfig> {
    let _guard = access().lock().unwrap();
    read_store()
        .providers
        .into_iter()
        .map(|mut p| {
            if p.password.as_deref().is_some_and(|v| !v.is_empty()) {
                p.password = Some("••••".into());
            }
            p
        })
        .collect()
}

#[tauri::command]
pub fn storage_provider_upsert(mut config: StorageProviderConfig) -> Result<(), String> {
    crate::policy::require_feature("cloud-storage")?;
    validate(&config)?;
    let _guard = access().lock().unwrap();
    let mut store = read_store();
    if let Some(existing) = store.providers.iter_mut().find(|p| p.id == config.id) {
        if config.password.as_deref() == Some("••••") {
            config.password = existing.password.clone();
        }
        *existing = config;
    } else {
        store.providers.push(config);
    }
    write_store(&store)
}

#[tauri::command]
pub fn storage_provider_remove(id: String) -> Result<(), String> {
    let _guard = access().lock().unwrap();
    let mut store = read_store();
    store.providers.retain(|p| p.id != id);
    write_store(&store)
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
    let path = normalize_path(&path);
    let response = propfind(&config, &path, "1").await?;
    if !(response.status().is_success() || response.status().as_u16() == 207) {
        return Err(response_error(response, "列出目录").await);
    }
    let xml = response
        .text()
        .await
        .map_err(|e| format!("读取 WebDAV XML：{e}"))?;
    parse_propfind(&xml, &config, &path)
}

#[tauri::command]
pub async fn storage_read_text(id: String, path: String) -> Result<String, String> {
    crate::policy::require_feature("cloud-storage")?;
    let config = provider(&id)?;
    let response = request(&config, reqwest::Method::GET, &normalize_path(&path))?
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(response_error(response, "读取文件").await);
    }
    if response
        .content_length()
        .is_some_and(|n| n > 5 * 1024 * 1024)
    {
        return Err("文本文件超过 5MB 限制".into());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("读取文件失败：{e}"))?;
        if bytes.len() + chunk.len() > 5 * 1024 * 1024 {
            return Err("文本文件超过 5MB 限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|e| format!("文件不是有效 UTF-8 文本：{e}"))
}

#[tauri::command]
pub async fn storage_write_text(id: String, path: String, content: String) -> Result<(), String> {
    crate::policy::require_feature("cloud-storage")?;
    let config = provider(&id)?;
    let response = request(&config, reqwest::Method::PUT, &normalize_path(&path))?
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
pub async fn storage_delete(id: String, path: String) -> Result<(), String> {
    crate::policy::require_feature("cloud-storage")?;
    let config = provider(&id)?;
    let response = request(&config, reqwest::Method::DELETE, &normalize_path(&path))?
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
    let method = reqwest::Method::from_bytes(b"MKCOL").unwrap();
    let response = request(&config, method, &normalize_path(&path))?
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
    fn normalizes_traversal_out_of_relative_paths() {
        assert_eq!(normalize_path("/a/../b"), "/a/b");
        assert_eq!(normalize_path(""), "/");
    }
}
