//! Personal knowledge indexing and retrieval.
//!
//! Source files remain in the user-selected folders. Extracted text is chunked
//! into a private SQLite FTS5/sqlite-vec index under the EchoAgent data home.
//! Retrieval combines BM25 and bge-m3 vectors, then applies the configured
//! bge-reranker-v2-m3 model. Every network-dependent stage has a lexical
//! fallback so a provider outage never prevents the user's task from running.

use echo_agent_memory::{
    backend::MemoryBackendImpl,
    embedding::{ApiEmbeddingProvider, EmbeddingProvider},
    index::{init_sqlite_vec, MemoryIndex},
    reranker::ApiReranker,
    search::SearchResult,
    storage::MemoryStorage,
};
use echo_agent_runtime::config::{MemoryEmbeddingConfig, MemoryIndexConfig, MemorySearchConfig};
use echo_agent_tools::types::memory_backend::MemoryBackend;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;

const INDEX_VERSION: u32 = 1;
const INDEX_DIR: &str = "personal-knowledge";
const INDEX_DOCUMENTS_DIR: &str = "documents";
const INDEX_DATABASE: &str = "index.sqlite";
const INDEX_MANIFEST: &str = "manifest.json";
const MAX_LOCAL_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_OFFICE_ENTRY_BYTES: u64 = 2 * 1024 * 1024;
const MAX_OFFICE_XML_BYTES: u64 = 8 * 1024 * 1024;
const MAX_LOCAL_SCAN_ENTRIES: usize = 10_000;
const MAX_LOCAL_FILES: usize = 500;
const MAX_INDEXED_CONTENT_CHARS: usize = 512 * 1024;
const MAX_QUERY_CHARS: usize = 8_192;
const MAX_SEARCH_RESULTS: usize = 20;
const SEARCH_TIMEOUT: Duration = Duration::from_secs(6);
const RERANK_TIMEOUT: Duration = Duration::from_secs(4);
const EMBED_BATCH_TIMEOUT: Duration = Duration::from_secs(45);
const SEARCH_CANCELLED: &str = "personal knowledge search cancelled";
const BACKGROUND_REFRESH_INTERVAL: Duration = Duration::from_secs(60);
const MAX_SEARCH_REQUEST_ID_CHARS: usize = 128;

static INDEX_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
static RUNTIME_STATUS: OnceLock<Mutex<RuntimeIndexStatus>> = OnceLock::new();
static REBUILD_SCHEDULE: OnceLock<Mutex<RebuildScheduleState>> = OnceLock::new();
static ACTIVE_SEARCHES: OnceLock<Mutex<HashMap<String, Arc<CancellationToken>>>> = OnceLock::new();

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalSource {
    id: String,
    label: String,
    root: String,
    #[serde(default = "default_true")]
    enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone)]
struct SourceFile {
    path: PathBuf,
    source_id: String,
    source_label: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexManifest {
    version: u32,
    embedding_model: String,
    last_updated_at: Option<u64>,
    entries: Vec<ManifestEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestEntry {
    original_path: String,
    cache_path: String,
    title: String,
    source_id: String,
    source_label: String,
    modified_millis: u64,
    size: u64,
}

#[derive(Debug, Clone, Default)]
struct RuntimeIndexStatus {
    state: String,
    message: Option<String>,
    file_count: usize,
    chunk_count: usize,
    embedded_chunk_count: usize,
    pending_embedding_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalKnowledgeIndexStatus {
    state: String,
    message: Option<String>,
    file_count: usize,
    chunk_count: usize,
    embedded_chunk_count: usize,
    pending_embedding_count: usize,
    last_updated_at: Option<u64>,
    embedding_model: &'static str,
    rerank_model: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalKnowledgeEntry {
    id: String,
    title: String,
    snippet: String,
    source: String,
    source_label: String,
    url: String,
    path: String,
    start_line: usize,
    end_line: usize,
    score: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalKnowledgeSearchResponse {
    items: Vec<PersonalKnowledgeEntry>,
    retrieval_mode: String,
    degraded_reason: Option<String>,
    index: PersonalKnowledgeIndexStatus,
}

#[derive(Debug)]
struct SyncResult {
    manifest: IndexManifest,
    chunk_count: usize,
    pending_embedding_count: usize,
    vec_available: bool,
}

#[derive(Debug, Default)]
struct RebuildScheduleState {
    running: bool,
    pending: bool,
    force: bool,
    last_finished_at: Option<Instant>,
}

fn index_lock() -> &'static tokio::sync::Mutex<()> {
    INDEX_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn runtime_status() -> &'static Mutex<RuntimeIndexStatus> {
    RUNTIME_STATUS.get_or_init(|| {
        Mutex::new(RuntimeIndexStatus {
            state: "idle".to_owned(),
            ..RuntimeIndexStatus::default()
        })
    })
}

fn rebuild_schedule() -> &'static Mutex<RebuildScheduleState> {
    REBUILD_SCHEDULE.get_or_init(|| Mutex::new(RebuildScheduleState::default()))
}

fn active_searches() -> &'static Mutex<HashMap<String, Arc<CancellationToken>>> {
    ACTIVE_SEARCHES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn update_runtime_status(update: impl FnOnce(&mut RuntimeIndexStatus)) {
    if let Ok(mut status) = runtime_status().lock() {
        update(&mut status);
    }
}

fn index_root() -> PathBuf {
    crate::paths::echo_agent_home_dir().join(INDEX_DIR)
}

fn documents_dir() -> PathBuf {
    index_root().join(INDEX_DOCUMENTS_DIR)
}

fn database_path() -> PathBuf {
    index_root().join(INDEX_DATABASE)
}

fn manifest_path() -> PathBuf {
    index_root().join(INDEX_MANIFEST)
}

fn memory_storage() -> MemoryStorage {
    let root = index_root();
    MemoryStorage::new_flat(&root, &root)
}

fn embedding_config() -> MemoryEmbeddingConfig {
    MemoryEmbeddingConfig {
        provider: "api".to_owned(),
        model: Some(crate::agent_runtime::MEMORY_EMBEDDING_MODEL.to_owned()),
        dimensions: crate::agent_runtime::MEMORY_EMBEDDING_DIMENSIONS,
        endpoint: Some(crate::agent_runtime::MEMORY_EMBEDDING_ENDPOINT.to_owned()),
        api_key: Some(crate::agent_runtime::MEMORY_SILICONFLOW_API_KEY.to_owned()),
        send_dimensions: false,
    }
}

fn coarse_search_config(candidate_count: usize) -> MemorySearchConfig {
    let mut config = MemorySearchConfig {
        max_results: candidate_count,
        min_score: 0.1,
        vector_weight: 0.7,
        text_weight: 0.3,
        ..Default::default()
    };
    config.temporal_decay.enabled = false;
    config.mmr.enabled = false;
    config.reranker.enabled = false;
    config
}

fn reranker_config() -> MemorySearchConfig {
    let mut config = MemorySearchConfig::default();
    config.reranker.enabled = true;
    config.reranker.endpoint = Some(crate::agent_runtime::MEMORY_RERANK_ENDPOINT.to_owned());
    config.reranker.model = Some(crate::agent_runtime::MEMORY_RERANK_MODEL.to_owned());
    config.reranker.api_key = Some(crate::agent_runtime::MEMORY_SILICONFLOW_API_KEY.to_owned());
    config
}

fn embedding_provider() -> Option<ApiEmbeddingProvider> {
    ApiEmbeddingProvider::from_session(
        &embedding_config(),
        crate::agent_runtime::MEMORY_EMBEDDING_ENDPOINT.to_owned(),
        crate::agent_runtime::MEMORY_SILICONFLOW_API_KEY.to_owned(),
    )
}

fn load_sources() -> Result<Vec<LocalSource>, String> {
    let value = crate::org::org_local_kb_sources_get()?;
    let items = value
        .as_array()
        .ok_or_else(|| "personal knowledge sources must be an array".to_owned())?;
    let mut sources = Vec::new();
    for item in items {
        let source: LocalSource = serde_json::from_value(item.clone())
            .map_err(|error| format!("decode personal knowledge source: {error}"))?;
        if !source.enabled || source.id.trim().is_empty() || source.root.trim().is_empty() {
            continue;
        }
        let Ok(root) = std::fs::canonicalize(&source.root) else {
            continue;
        };
        if root.is_dir() {
            sources.push(LocalSource {
                root: root.to_string_lossy().into_owned(),
                ..source
            });
        }
    }
    Ok(sources)
}

pub(crate) fn configured() -> bool {
    load_sources().is_ok_and(|sources| !sources.is_empty())
}

fn supported_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("md" | "markdown" | "mdx" | "txt" | "rst" | "log" | "docx" | "pptx" | "xlsx")
    )
}

fn scan_files() -> Result<Vec<SourceFile>, String> {
    let mut out = Vec::new();
    let mut seen_files = HashSet::new();
    let mut scanned_entries = 0usize;
    for source in load_sources()? {
        let root = PathBuf::from(&source.root);
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
            let Ok(entries) = std::fs::read_dir(&canonical_directory) else {
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
                } else if metadata.is_file()
                    && supported_file(&canonical)
                    && seen_files.insert(canonical.clone())
                {
                    out.push(SourceFile {
                        path: canonical,
                        source_id: source.id.clone(),
                        source_label: source.label.clone(),
                    });
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
    out.sort_by(|left, right| left.path.cmp(&right.path));
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
                        out.push(value.to_string());
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

fn read_source_file(path: &Path) -> Result<String, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("read personal knowledge metadata: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("personal knowledge path must be a regular file".into());
    }
    if metadata.len() > MAX_LOCAL_FILE_BYTES {
        return Err("personal knowledge file exceeds 5MB".into());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let bytes = crate::shell_fs::read_regular_file_bounded(path, MAX_LOCAL_FILE_BYTES)
        .map_err(|error| format!("read personal knowledge: {error}"))?;
    if matches!(extension.as_str(), "docx" | "pptx" | "xlsx") {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
            .map_err(|error| format!("open personal knowledge Office ZIP: {error}"))?;
        let mut parts = Vec::new();
        let mut total_xml_bytes = 0_u64;
        for index in 0..archive.len().min(500) {
            let mut entry = archive
                .by_index(index)
                .map_err(|error| format!("read personal knowledge Office entry: {error}"))?;
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
                return Err("personal knowledge Office XML entry exceeds 2MB".into());
            }
            let remaining = MAX_OFFICE_XML_BYTES.saturating_sub(total_xml_bytes);
            if remaining == 0 || entry.size() > remaining {
                return Err("personal knowledge Office XML content exceeds 8MB".into());
            }
            let read_limit = remaining.min(MAX_OFFICE_ENTRY_BYTES);
            let mut bytes = Vec::new();
            (&mut entry)
                .take(read_limit + 1)
                .read_to_end(&mut bytes)
                .map_err(|error| format!("read personal knowledge Office XML: {error}"))?;
            if bytes.len() as u64 > read_limit {
                return Err("personal knowledge Office XML content exceeds its size limit".into());
            }
            total_xml_bytes = total_xml_bytes.saturating_add(bytes.len() as u64);
            let xml = String::from_utf8(bytes)
                .map_err(|_| "personal knowledge Office XML is not valid UTF-8".to_owned())?;
            parts.push(xml_text(&xml));
        }
        return Ok(parts.join("\n"));
    }
    String::from_utf8(bytes).map_err(|_| "personal knowledge file is not valid UTF-8".into())
}

fn canonical_authorized_path(raw: &str) -> Result<PathBuf, String> {
    let path = std::fs::canonicalize(raw)
        .map_err(|_| "personal knowledge file does not exist".to_owned())?;
    if !path.is_file() || !supported_file(&path) {
        return Err("unsupported personal knowledge file".into());
    }
    let roots = load_sources()?
        .into_iter()
        .map(|source| PathBuf::from(source.root))
        .collect::<Vec<_>>();
    if !roots.iter().any(|root| path.starts_with(root)) {
        return Err("personal knowledge path is outside configured roots".into());
    }
    Ok(path)
}

pub(crate) fn fetch(raw: &str) -> Result<String, String> {
    read_source_file(&canonical_authorized_path(raw)?)
}

fn modified_millis(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or_default()
}

fn cache_path_for(original: &Path) -> PathBuf {
    let digest = Sha256::digest(original.to_string_lossy().as_bytes());
    documents_dir().join(format!("{:x}.md", digest))
}

fn title_for(path: &Path) -> String {
    path.file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("未命名知识")
        .to_owned()
}

fn bounded_content(text: &str) -> String {
    text.chars().take(MAX_INDEXED_CONTENT_CHARS).collect()
}

fn index_document(title: &str, text: &str) -> String {
    format!("# {title}\n\n{}", bounded_content(text))
}

fn load_manifest() -> IndexManifest {
    let Ok(bytes) = std::fs::read(manifest_path()) else {
        return IndexManifest::default();
    };
    serde_json::from_slice::<IndexManifest>(&bytes)
        .ok()
        .filter(|manifest| manifest.version == INDEX_VERSION)
        .unwrap_or_default()
}

fn save_manifest(manifest: &IndexManifest) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|error| format!("encode personal knowledge index manifest: {error}"))?;
    crate::paths::write_private_file(&manifest_path(), &bytes)
}

fn remove_database_files() {
    let database = database_path();
    for path in [
        database.clone(),
        PathBuf::from(format!("{}-wal", database.to_string_lossy())),
        PathBuf::from(format!("{}-shm", database.to_string_lossy())),
    ] {
        let _ = std::fs::remove_file(path);
    }
}

fn open_index() -> Result<MemoryIndex, String> {
    init_sqlite_vec();
    MemoryIndex::open_or_create(
        &database_path(),
        memory_storage(),
        MemoryIndexConfig::default(),
        crate::agent_runtime::MEMORY_EMBEDDING_DIMENSIONS,
    )
    .map_err(|error| format!("open personal knowledge index: {error}"))
}

fn sync_index(force: bool) -> Result<SyncResult, String> {
    std::fs::create_dir_all(documents_dir())
        .map_err(|error| format!("create personal knowledge index: {error}"))?;
    crate::paths::harden_private_dir(&index_root())?;
    crate::paths::harden_private_dir(&documents_dir())?;

    let old_manifest = load_manifest();
    if force {
        remove_database_files();
    }
    let mut index = open_index()?;
    let indexed_paths = index
        .all_indexed_paths()
        .map_err(|error| format!("read personal knowledge index paths: {error}"))?
        .into_iter()
        .collect::<HashSet<_>>();
    let old_by_original = old_manifest
        .entries
        .iter()
        .cloned()
        .map(|entry| (entry.original_path.clone(), entry))
        .collect::<HashMap<_, _>>();
    let mut next_entries = Vec::new();

    for source_file in scan_files()? {
        let Ok(metadata) = std::fs::metadata(&source_file.path) else {
            continue;
        };
        if metadata.len() > MAX_LOCAL_FILE_BYTES {
            continue;
        }
        let original_path = source_file.path.to_string_lossy().into_owned();
        let cache_path = cache_path_for(&source_file.path);
        let cache_path_string = cache_path.to_string_lossy().into_owned();
        let title = title_for(&source_file.path);
        let modified = modified_millis(&metadata);
        let previous = old_by_original.get(&original_path);
        let unchanged = !force
            && previous.is_some_and(|entry| {
                entry.modified_millis == modified
                    && entry.size == metadata.len()
                    && Path::new(&entry.cache_path).is_file()
            });

        if !unchanged {
            match read_source_file(&source_file.path) {
                Ok(text) if !text.trim().is_empty() => {
                    crate::paths::write_private_file(
                        &cache_path,
                        index_document(&title, &text).as_bytes(),
                    )?;
                }
                Ok(_) => continue,
                Err(error) => {
                    tracing::warn!(path = %source_file.path.display(), %error, "personal knowledge file was skipped");
                    if let Some(previous) =
                        previous.filter(|entry| Path::new(&entry.cache_path).is_file())
                    {
                        if force || !indexed_paths.contains(&previous.cache_path) {
                            index
                                .reindex_file(Path::new(&previous.cache_path), "workspace")
                                .map_err(|error| {
                                    format!("reindex cached personal knowledge: {error}")
                                })?;
                        }
                        next_entries.push(previous.clone());
                    }
                    continue;
                }
            }
        }

        if force || !unchanged || !indexed_paths.contains(&cache_path_string) {
            index
                .reindex_file(&cache_path, "workspace")
                .map_err(|error| format!("index personal knowledge file: {error}"))?;
        }
        next_entries.push(ManifestEntry {
            original_path,
            cache_path: cache_path_string,
            title,
            source_id: source_file.source_id,
            source_label: source_file.source_label,
            modified_millis: modified,
            size: metadata.len(),
        });
    }

    let active_cache_paths = next_entries
        .iter()
        .map(|entry| entry.cache_path.clone())
        .collect::<HashSet<_>>();
    for old in &old_manifest.entries {
        if !active_cache_paths.contains(&old.cache_path) {
            index
                .delete_path(Path::new(&old.cache_path))
                .map_err(|error| format!("remove stale personal knowledge chunks: {error}"))?;
            let _ = std::fs::remove_file(&old.cache_path);
        }
    }
    for indexed in indexed_paths {
        if !active_cache_paths.contains(&indexed) {
            index
                .delete_path(Path::new(&indexed))
                .map_err(|error| format!("remove orphaned personal knowledge chunks: {error}"))?;
        }
    }

    next_entries.sort_by(|left, right| left.original_path.cmp(&right.original_path));
    let mut manifest = IndexManifest {
        version: INDEX_VERSION,
        embedding_model: crate::agent_runtime::MEMORY_EMBEDDING_MODEL.to_owned(),
        last_updated_at: Some(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .min(u128::from(u64::MAX)) as u64,
        ),
        entries: next_entries,
    };
    if manifest.entries.is_empty() {
        manifest.last_updated_at = None;
    }
    save_manifest(&manifest)?;
    let vec_available = index.vec_available();
    let pending_embedding_count = index
        .chunks_without_embeddings()
        .map_err(|error| format!("read pending personal knowledge embeddings: {error}"))?
        .len();
    drop(index);
    let chunk_count = memory_storage().total_chunk_count();
    // sqlite-vec is optional in the shared memory crate. Treat every chunk as
    // pending when the extension is unavailable so the UI never reports a
    // keyword-only index as fully semantic.
    let pending_embedding_count = if vec_available {
        pending_embedding_count
    } else {
        chunk_count
    };
    Ok(SyncResult {
        manifest,
        chunk_count,
        pending_embedding_count,
        vec_available,
    })
}

async fn embed_pending(max_batches: Option<usize>) -> Result<(usize, usize), String> {
    let Some(provider) = embedding_provider() else {
        return Err("personal knowledge embedding provider is not configured".into());
    };
    let pending = {
        let index = open_index()?;
        index
            .ensure_embedding_fingerprint(&provider.fingerprint())
            .map_err(|error| format!("validate personal knowledge embedding cache: {error}"))?;
        index
            .chunks_without_embeddings()
            .map_err(|error| format!("read personal knowledge embedding queue: {error}"))?
    };
    let total = pending.len();
    let batch_limit = max_batches.unwrap_or(usize::MAX);
    let mut embedded = 0usize;
    for batch in pending.chunks(32).take(batch_limit) {
        let texts = batch
            .iter()
            .map(|(_, text)| text.as_str())
            .collect::<Vec<_>>();
        let embeddings = tokio::time::timeout(EMBED_BATCH_TIMEOUT, provider.embed_batch(&texts))
            .await
            .map_err(|_| "personal knowledge embedding request timed out".to_owned())?
            .map_err(|error| format!("personal knowledge embedding request failed: {error}"))?;
        if embeddings.len() != batch.len()
            || embeddings.iter().any(|embedding| {
                embedding.len() != crate::agent_runtime::MEMORY_EMBEDDING_DIMENSIONS
                    || embedding.iter().any(|value| !value.is_finite())
            })
        {
            return Err("personal knowledge embedding response has invalid dimensions".into());
        }
        let index = open_index()?;
        for ((chunk_id, _), embedding) in batch.iter().zip(embeddings.iter()) {
            index
                .upsert_embedding(chunk_id, embedding)
                .map_err(|error| format!("store personal knowledge embedding: {error}"))?;
            embedded += 1;
        }
        update_runtime_status(|status| {
            status.embedded_chunk_count = status.embedded_chunk_count.saturating_add(batch.len());
            status.pending_embedding_count = total.saturating_sub(embedded);
            status.message = Some(format!("正在生成语义索引（{embedded}/{total}）"));
        });
    }
    Ok((embedded, total.saturating_sub(embedded)))
}

fn index_status_snapshot() -> PersonalKnowledgeIndexStatus {
    let manifest = load_manifest();
    let disk_file_count = manifest.entries.len();
    let disk_chunk_count = if database_path().is_file() {
        memory_storage().total_chunk_count()
    } else {
        0
    };
    let disk_pending = if database_path().is_file() {
        open_index()
            .and_then(|index| {
                if !index.vec_available() {
                    return Ok(disk_chunk_count);
                }
                index
                    .chunks_without_embeddings()
                    .map(|pending| pending.len())
                    .map_err(|error| format!("read personal knowledge index status: {error}"))
            })
            .unwrap_or(disk_chunk_count)
    } else {
        0
    };
    let runtime = runtime_status()
        .lock()
        .map(|status| status.clone())
        .unwrap_or_default();
    let active =
        runtime.state == "indexing" || runtime.state == "error" || runtime.state == "degraded";
    let file_count = if active {
        runtime.file_count
    } else {
        disk_file_count
    };
    let chunk_count = if active {
        runtime.chunk_count
    } else {
        disk_chunk_count
    };
    let pending_embedding_count = if active {
        runtime.pending_embedding_count
    } else {
        disk_pending
    };
    let embedded_chunk_count = if active {
        runtime.embedded_chunk_count
    } else {
        chunk_count.saturating_sub(pending_embedding_count)
    };
    let state = if active {
        runtime.state
    } else if file_count == 0 {
        "idle".to_owned()
    } else if pending_embedding_count > 0 {
        "degraded".to_owned()
    } else {
        "ready".to_owned()
    };
    PersonalKnowledgeIndexStatus {
        state,
        message: runtime.message,
        file_count,
        chunk_count,
        embedded_chunk_count,
        pending_embedding_count,
        last_updated_at: manifest.last_updated_at,
        embedding_model: crate::agent_runtime::MEMORY_EMBEDDING_MODEL,
        rerank_model: crate::agent_runtime::MEMORY_RERANK_MODEL,
    }
}

fn emit_status(app: &AppHandle) {
    let _ = app.emit("personal-knowledge://index-status", index_status_snapshot());
}

async fn rebuild_inner(
    app: Option<&AppHandle>,
    force: bool,
) -> Result<PersonalKnowledgeIndexStatus, String> {
    let _guard = index_lock().lock().await;
    update_runtime_status(|status| {
        *status = RuntimeIndexStatus {
            state: "indexing".to_owned(),
            message: Some("正在扫描个人知识文件".to_owned()),
            ..RuntimeIndexStatus::default()
        };
    });
    if let Some(app) = app {
        emit_status(app);
    }
    // Directory walking, Office extraction and SQLite indexing are blocking
    // work. Keep them off Tauri's async workers; the mutex only serializes
    // rebuild jobs and is never consulted by prompt-time search.
    let synced = match tokio::task::spawn_blocking(move || sync_index(force)).await {
        Ok(Ok(synced)) => synced,
        Ok(Err(error)) => {
            update_runtime_status(|status| {
                status.state = "error".to_owned();
                status.message = Some(error.clone());
            });
            if let Some(app) = app {
                emit_status(app);
            }
            return Err(error);
        }
        Err(error) => {
            let error = format!("personal knowledge indexing worker failed: {error}");
            update_runtime_status(|status| {
                status.state = "error".to_owned();
                status.message = Some(error.clone());
            });
            if let Some(app) = app {
                emit_status(app);
            }
            return Err(error);
        }
    };
    update_runtime_status(|status| {
        status.file_count = synced.manifest.entries.len();
        status.chunk_count = synced.chunk_count;
        status.embedded_chunk_count = synced
            .chunk_count
            .saturating_sub(synced.pending_embedding_count);
        status.pending_embedding_count = synced.pending_embedding_count;
        status.message = Some(if synced.pending_embedding_count > 0 {
            format!("正在生成语义索引（0/{}）", synced.pending_embedding_count)
        } else {
            "索引已是最新状态".to_owned()
        });
    });
    if let Some(app) = app {
        emit_status(app);
    }

    let embedding_result = if synced.vec_available && synced.pending_embedding_count > 0 {
        embed_pending(None).await
    } else {
        Ok((0, 0))
    };
    let remaining = if synced.vec_available {
        open_index()
            .and_then(|index| {
                index.chunks_without_embeddings().map_err(|error| {
                    format!("read remaining personal knowledge embeddings: {error}")
                })
            })
            .map(|pending| pending.len())
            .unwrap_or(synced.pending_embedding_count)
    } else {
        synced.chunk_count
    };
    update_runtime_status(|status| match embedding_result {
        Ok(_) if remaining == 0 => {
            status.state = if status.file_count == 0 {
                "idle"
            } else {
                "ready"
            }
            .to_owned();
            status.message = if status.file_count == 0 {
                None
            } else {
                Some("语义索引已就绪".to_owned())
            };
            status.embedded_chunk_count = status.chunk_count;
            status.pending_embedding_count = 0;
        }
        Ok(_) => {
            status.state = "degraded".to_owned();
            status.message = Some("部分内容正在后台生成向量，当前仍可使用关键词检索".to_owned());
            status.pending_embedding_count = remaining;
            status.embedded_chunk_count = status.chunk_count.saturating_sub(remaining);
        }
        Err(ref error) => {
            status.state = "degraded".to_owned();
            status.message = Some(format!("向量服务暂不可用，已保留关键词检索：{error}"));
            status.pending_embedding_count = remaining;
            status.embedded_chunk_count = status.chunk_count.saturating_sub(remaining);
        }
    });
    if let Some(app) = app {
        emit_status(app);
    }
    Ok(index_status_snapshot())
}

pub(crate) fn schedule_rebuild(app: AppHandle, force: bool) {
    {
        let mut schedule = rebuild_schedule().lock().unwrap();
        schedule.pending = true;
        schedule.force |= force;
        if schedule.running {
            return;
        }
        schedule.running = true;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            let force = {
                let mut schedule = rebuild_schedule().lock().unwrap();
                schedule.pending = false;
                std::mem::take(&mut schedule.force)
            };
            if crate::org::local_knowledge_allowed().await {
                if let Err(error) = rebuild_inner(Some(&app), force).await {
                    tracing::warn!(%error, "personal knowledge background indexing failed");
                }
            }
            let mut schedule = rebuild_schedule().lock().unwrap();
            schedule.last_finished_at = Some(Instant::now());
            if schedule.pending {
                continue;
            }
            schedule.running = false;
            break;
        }
    });
}

pub(crate) fn start_background_index(app: AppHandle) {
    if configured() {
        schedule_rebuild(app, false);
    }
}

fn strip_cached_heading(snippet: &str, title: &str) -> String {
    snippet
        .strip_prefix(&format!("# {title}\n\n"))
        .unwrap_or(snippet)
        .trim()
        .to_owned()
}

fn map_results(
    results: Vec<SearchResult>,
    manifest: &IndexManifest,
) -> Vec<PersonalKnowledgeEntry> {
    let by_cache = manifest
        .entries
        .iter()
        .map(|entry| (entry.cache_path.as_str(), entry))
        .collect::<HashMap<_, _>>();
    results
        .into_iter()
        .filter_map(|result| {
            let entry = by_cache.get(result.path.as_str())?;
            let start_line = result.start_line.saturating_sub(2) + 1;
            let end_line = result.end_line.saturating_sub(2).max(start_line);
            Some(PersonalKnowledgeEntry {
                id: format!("{}#L{}", entry.original_path, start_line),
                title: entry.title.clone(),
                snippet: strip_cached_heading(&result.snippet, &entry.title),
                source: entry.source_id.clone(),
                source_label: entry.source_label.clone(),
                url: entry.original_path.clone(),
                path: entry.original_path.clone(),
                start_line,
                end_line,
                score: result.score,
            })
        })
        .collect()
}

async fn rerank_candidates(
    query: &str,
    candidates: Vec<SearchResult>,
    limit: usize,
    cancellation: &CancellationToken,
) -> Result<Vec<SearchResult>, String> {
    let config = reranker_config();
    let reranker = ApiReranker::from_config(&config.reranker)
        .ok_or_else(|| "personal knowledge reranker is not configured".to_owned())?;
    tokio::select! {
        _ = cancellation.cancelled() => Err(SEARCH_CANCELLED.to_owned()),
        result = tokio::time::timeout(RERANK_TIMEOUT, reranker.rerank(query, &candidates, limit)) => {
            result
                .map_err(|_| "personal knowledge rerank request timed out".to_owned())?
                .map_err(|error| format!("personal knowledge rerank request failed: {error}"))
        }
    }
}

async fn search_hybrid(
    query: &str,
    limit: usize,
    manifest: &IndexManifest,
    cancellation: &CancellationToken,
) -> Result<(Vec<PersonalKnowledgeEntry>, bool, Option<String>), String> {
    let candidate_count = limit.saturating_mul(5).clamp(limit, 60);
    let config = coarse_search_config(candidate_count);
    let backend = MemoryBackendImpl::new(database_path(), memory_storage())
        .with_embedding(
            embedding_config(),
            crate::agent_runtime::MEMORY_EMBEDDING_ENDPOINT.to_owned(),
            Some(crate::agent_runtime::MEMORY_SILICONFLOW_API_KEY.to_owned()),
        )
        .with_search_config(config);
    let coarse = tokio::select! {
        _ = cancellation.cancelled() => return Err(SEARCH_CANCELLED.to_owned()),
        result = tokio::time::timeout(SEARCH_TIMEOUT, backend.search(query, candidate_count, 0.1)) => {
            result
                .map_err(|_| "personal knowledge hybrid search timed out".to_owned())?
                .map_err(|error| format!("personal knowledge hybrid search failed: {error}"))?
        }
    };
    let candidates = coarse
        .into_iter()
        .map(|result| SearchResult {
            chunk_id: result.chunk_id,
            path: result.path,
            start_line: result.start_line,
            end_line: result.end_line,
            score: result.score,
            snippet: result.snippet,
            source: result.source,
            created_at: result.created_at.unwrap_or_default(),
        })
        .collect::<Vec<_>>();
    if candidates.len() <= 1 {
        return Ok((map_results(candidates, manifest), false, None));
    }
    match rerank_candidates(query, candidates.clone(), limit, cancellation).await {
        Ok(reranked) => Ok((map_results(reranked, manifest), true, None)),
        Err(error) if error == SEARCH_CANCELLED => Err(error),
        Err(error) => {
            tracing::warn!(%error, "personal knowledge reranking degraded to hybrid ordering");
            Ok((
                map_results(candidates.into_iter().take(limit).collect(), manifest),
                false,
                Some(error),
            ))
        }
    }
}

fn search_terms(query: &str) -> Vec<String> {
    let normalized = query.trim().to_lowercase();
    let mut terms = vec![normalized.clone()];
    let mut current = String::new();
    let mut sequences = Vec::new();
    for character in normalized.chars() {
        if character.is_alphanumeric() || matches!(character, '_' | '-' | '.') {
            current.push(character);
        } else if !current.is_empty() {
            sequences.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        sequences.push(current);
    }
    let ignored = [
        "什么",
        "怎么",
        "如何",
        "是否",
        "可以",
        "请问",
        "一下",
        "哪些",
        "为什么",
        "关于",
        "介绍",
        "告诉",
        "帮我",
        "根据",
        "知识",
        "文件",
        "里面",
        "内容",
        "这个",
        "那个",
        "是什么",
        "请说明",
    ];
    for sequence in sequences {
        let chars = sequence.chars().collect::<Vec<_>>();
        if chars
            .iter()
            .any(|character| matches!(*character, '\u{3400}'..='\u{9fff}'))
        {
            for size in [4usize, 3, 2] {
                for window in chars.windows(size) {
                    let term = window.iter().collect::<String>();
                    if !ignored.contains(&term.as_str()) {
                        terms.push(term);
                    }
                }
            }
        } else if chars.len() >= 2 {
            terms.push(sequence);
        }
    }
    let mut seen = HashSet::new();
    terms.retain(|term| term.chars().count() >= 2 && seen.insert(term.clone()));
    terms.sort_by_key(|right| std::cmp::Reverse(right.chars().count()));
    terms.truncate(12);
    terms
}

fn snippet_around(text: &str, byte_position: usize, max_chars: usize) -> String {
    let approximate_character = text
        .get(..byte_position)
        .map(|prefix| prefix.chars().count())
        .unwrap_or_default();
    let start = approximate_character.saturating_sub(max_chars / 4);
    let snippet = text.chars().skip(start).take(max_chars).collect::<String>();
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        snippet,
        if start + max_chars < text.chars().count() {
            "…"
        } else {
            ""
        }
    )
}

/// Fast degradation path backed by the already-built SQLite FTS index.
/// Prompt-time retrieval must never rescan and reread the user's source tree.
fn indexed_lexical_search(
    query: &str,
    limit: usize,
    manifest: &IndexManifest,
) -> Result<Vec<PersonalKnowledgeEntry>, String> {
    if !database_path().is_file() {
        return Ok(Vec::new());
    }
    let index = open_index()?;
    let terms = search_terms(query);
    let by_cache = manifest
        .entries
        .iter()
        .map(|entry| (entry.cache_path.as_str(), entry))
        .collect::<HashMap<_, _>>();
    let mut by_id: HashMap<String, PersonalKnowledgeEntry> = HashMap::new();
    let candidate_limit = limit.saturating_mul(4).clamp(limit, 80);
    for (term_index, term) in terms.iter().enumerate() {
        let hits = index
            .search_fts(term, candidate_limit)
            .map_err(|error| format!("search personal knowledge FTS index: {error}"))?;
        for hit in hits {
            let Some(chunk) = index
                .get_chunk(&hit.chunk_id)
                .map_err(|error| format!("read personal knowledge FTS result: {error}"))?
            else {
                continue;
            };
            let Some(source) = by_cache.get(chunk.path.as_str()) else {
                continue;
            };
            let start_line = chunk.start_line.saturating_sub(2) + 1;
            let end_line = chunk.end_line.saturating_sub(2).max(start_line);
            let id = format!("{}#L{}", source.original_path, start_line);
            let title_hit = source.title.to_lowercase().contains(term);
            let rank_quality = 1.0 / (1.0 + hit.rank.abs());
            let score = (terms.len().saturating_sub(term_index) * 10 + term.chars().count() * 2)
                as f64
                + if title_hit { 20.0 } else { 0.0 }
                + rank_quality;
            let text = strip_cached_heading(&chunk.text, &source.title);
            let candidate = PersonalKnowledgeEntry {
                id: id.clone(),
                title: source.title.clone(),
                snippet: snippet_around(&text, 0, 640),
                source: source.source_id.clone(),
                source_label: source.source_label.clone(),
                url: source.original_path.clone(),
                path: source.original_path.clone(),
                start_line,
                end_line,
                score,
            };
            if by_id
                .get(&id)
                .is_none_or(|previous| candidate.score > previous.score)
            {
                by_id.insert(id, candidate);
            }
        }
    }
    let mut results = by_id.into_values().collect::<Vec<_>>();
    results.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.title.cmp(&right.title))
    });
    results.truncate(limit);
    Ok(results)
}

async fn indexed_lexical_search_async(
    query: &str,
    limit: usize,
    manifest: &IndexManifest,
    cancellation: &CancellationToken,
) -> Result<Vec<PersonalKnowledgeEntry>, String> {
    let query = query.to_owned();
    let manifest = manifest.clone();
    let mut task =
        tokio::task::spawn_blocking(move || indexed_lexical_search(&query, limit, &manifest));
    tokio::select! {
        _ = cancellation.cancelled() => {
            task.abort();
            Err(SEARCH_CANCELLED.to_owned())
        }
        result = &mut task => result
            .map_err(|error| format!("personal knowledge keyword search worker failed: {error}"))?,
    }
}

fn should_refresh_in_background(manifest: &IndexManifest) -> bool {
    if let Ok(schedule) = rebuild_schedule().lock() {
        if schedule.running
            || schedule
                .last_finished_at
                .is_some_and(|finished| finished.elapsed() < BACKGROUND_REFRESH_INTERVAL)
        {
            return false;
        }
    }
    let Some(last_updated_at) = manifest.last_updated_at else {
        return true;
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    now.saturating_sub(Duration::from_millis(last_updated_at)) >= BACKGROUND_REFRESH_INTERVAL
}

fn validate_search_request_id(request_id: &str) -> Result<(), String> {
    let request_id = request_id.trim();
    if request_id.is_empty()
        || request_id.chars().count() > MAX_SEARCH_REQUEST_ID_CHARS
        || request_id.chars().any(char::is_control)
    {
        return Err("personal knowledge search request id is invalid".to_owned());
    }
    Ok(())
}

fn register_search(request_id: &str) -> Result<Arc<CancellationToken>, String> {
    validate_search_request_id(request_id)?;
    let token = Arc::new(CancellationToken::new());
    let previous = active_searches()
        .lock()
        .map_err(|_| "personal knowledge search registry is unavailable".to_owned())?
        .insert(request_id.to_owned(), token.clone());
    if let Some(previous) = previous {
        previous.cancel();
    }
    Ok(token)
}

fn unregister_search(request_id: &str, token: &Arc<CancellationToken>) {
    if let Ok(mut searches) = active_searches().lock() {
        if searches
            .get(request_id)
            .is_some_and(|current| Arc::ptr_eq(current, token))
        {
            searches.remove(request_id);
        }
    }
}

pub(crate) async fn search(
    query: &str,
    limit: usize,
    app: Option<&AppHandle>,
    cancellation: &CancellationToken,
) -> Result<PersonalKnowledgeSearchResponse, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("personal knowledge query cannot be empty".into());
    }
    if query.chars().count() > MAX_QUERY_CHARS {
        return Err(format!(
            "personal knowledge query cannot exceed {MAX_QUERY_CHARS} characters"
        ));
    }
    let limit = limit.clamp(1, MAX_SEARCH_RESULTS);
    if !crate::org::local_knowledge_allowed().await {
        return Err("signed organization policy disables personal knowledge".into());
    }
    if !configured() {
        return Ok(PersonalKnowledgeSearchResponse {
            items: Vec::new(),
            retrieval_mode: "none".to_owned(),
            degraded_reason: None,
            index: index_status_snapshot(),
        });
    }
    if cancellation.is_cancelled() {
        return Err(SEARCH_CANCELLED.to_owned());
    }

    // Prompt-time retrieval reads only the last committed index snapshot. File
    // walking, document extraction and embeddings are always background work.
    let manifest = load_manifest();
    if should_refresh_in_background(&manifest) {
        if let Some(app) = app {
            schedule_rebuild(app.clone(), false);
        }
    }
    let status = index_status_snapshot();
    if manifest.entries.is_empty() || !database_path().is_file() {
        return Ok(PersonalKnowledgeSearchResponse {
            items: Vec::new(),
            retrieval_mode: "keyword".to_owned(),
            degraded_reason: Some("个人知识索引正在后台建立，本次暂无可检索内容".to_owned()),
            index: status,
        });
    }

    let mut degraded_reason = (status.state == "indexing")
        .then(|| "个人知识索引正在后台更新，本次使用上一版完整索引".to_owned());
    let mut retrieval_mode = "keyword";
    let items = if status.embedded_chunk_count > 0 {
        match search_hybrid(query, limit, &manifest, cancellation).await {
            Ok((items, reranked, rerank_error)) if !items.is_empty() => {
                if let Some(error) = rerank_error {
                    degraded_reason = Some(format!("相关性重排暂不可用：{error}"));
                }
                retrieval_mode = if reranked {
                    "hybrid-reranked"
                } else {
                    "hybrid"
                };
                items
            }
            Ok(_) => indexed_lexical_search_async(query, limit, &manifest, cancellation).await?,
            Err(error) if error == SEARCH_CANCELLED => return Err(error),
            Err(error) => {
                tracing::warn!(%error, "personal knowledge semantic search degraded to indexed keyword retrieval");
                degraded_reason = Some(format!("语义检索暂不可用，本次已使用本地索引：{error}"));
                indexed_lexical_search_async(query, limit, &manifest, cancellation).await?
            }
        }
    } else {
        degraded_reason
            .get_or_insert_with(|| "语义索引正在后台生成，本次已使用关键词索引".to_owned());
        indexed_lexical_search_async(query, limit, &manifest, cancellation).await?
    };
    Ok(PersonalKnowledgeSearchResponse {
        items,
        retrieval_mode: retrieval_mode.to_owned(),
        degraded_reason,
        index: index_status_snapshot(),
    })
}

#[tauri::command]
pub async fn personal_knowledge_search(
    app: AppHandle,
    query: String,
    limit: Option<usize>,
    request_id: Option<String>,
) -> Result<PersonalKnowledgeSearchResponse, String> {
    let request_id = request_id
        .as_deref()
        .map(str::trim)
        .filter(|request_id| !request_id.is_empty());
    let token = match request_id {
        Some(request_id) => register_search(request_id)?,
        None => Arc::new(CancellationToken::new()),
    };
    let result = search(&query, limit.unwrap_or(5), Some(&app), token.as_ref()).await;
    if let Some(request_id) = request_id {
        unregister_search(request_id, &token);
    }
    result
}

#[tauri::command]
pub fn personal_knowledge_cancel_search(request_id: String) -> Result<bool, String> {
    validate_search_request_id(&request_id)?;
    let token = active_searches()
        .lock()
        .map_err(|_| "personal knowledge search registry is unavailable".to_owned())?
        .remove(request_id.trim());
    if let Some(token) = token {
        token.cancel();
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub async fn personal_knowledge_rebuild(
    app: AppHandle,
) -> Result<PersonalKnowledgeIndexStatus, String> {
    if !crate::org::local_knowledge_allowed().await {
        return Err("当前组织策略或连接状态不允许读取个人知识库".into());
    }
    let result = rebuild_inner(Some(&app), true).await;
    if let Ok(mut schedule) = rebuild_schedule().lock() {
        schedule.last_finished_at = Some(Instant::now());
    }
    result
}

#[tauri::command]
pub fn personal_knowledge_index_status() -> PersonalKnowledgeIndexStatus {
    index_status_snapshot()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn personal_retrieval_uses_requested_models() {
        let embedding = embedding_config();
        let search = reranker_config();
        assert_eq!(embedding.model.as_deref(), Some("BAAI/bge-m3"));
        assert_eq!(embedding.dimensions, 1024);
        assert_eq!(
            search.reranker.model.as_deref(),
            Some("BAAI/bge-reranker-v2-m3")
        );
        assert!(search.reranker.enabled);
    }

    #[test]
    fn lexical_terms_keep_exact_query_and_add_cjk_subphrases() {
        let terms = search_terms("公司的差旅费用标准是什么？");
        assert!(terms
            .iter()
            .any(|term| term == "公司的差旅费用标准是什么？"));
        assert!(terms.iter().any(|term| term == "差旅费用"));
        assert!(terms.iter().any(|term| term == "费用标准"));
    }

    #[test]
    fn cached_heading_is_not_exposed_as_answer_content() {
        assert_eq!(
            strip_cached_heading("# 休假制度\n\n员工每年享有十天年假。", "休假制度"),
            "员工每年享有十天年假。"
        );
    }

    #[test]
    fn cancelling_registered_search_reaches_its_native_token() {
        let request_id = "personal-search-cancel-test";
        let token = register_search(request_id).expect("register search");

        assert!(personal_knowledge_cancel_search(request_id.to_owned()).expect("cancel search"));
        assert!(token.is_cancelled());
        assert!(!personal_knowledge_cancel_search(request_id.to_owned()).expect("cancel again"));
    }

    #[test]
    fn search_request_ids_are_bounded() {
        assert!(validate_search_request_id("request-1").is_ok());
        assert!(validate_search_request_id("  ").is_err());
        assert!(validate_search_request_id(&"x".repeat(MAX_SEARCH_REQUEST_ID_CHARS + 1)).is_err());
    }

    #[test]
    fn indexed_cache_results_are_mapped_back_to_original_sources() {
        let manifest = IndexManifest {
            version: INDEX_VERSION,
            embedding_model: crate::agent_runtime::MEMORY_EMBEDDING_MODEL.to_owned(),
            last_updated_at: Some(1),
            entries: vec![ManifestEntry {
                original_path: "/notes/travel.md".to_owned(),
                cache_path: "/cache/hash.md".to_owned(),
                title: "差旅制度".to_owned(),
                source_id: "personal-notes".to_owned(),
                source_label: "个人笔记".to_owned(),
                modified_millis: 1,
                size: 10,
            }],
        };
        let mapped = map_results(
            vec![SearchResult {
                chunk_id: "/cache/hash.md:0".to_owned(),
                path: "/cache/hash.md".to_owned(),
                start_line: 3,
                end_line: 5,
                score: 0.91,
                snippet: "住宿标准为每晚 500 元。".to_owned(),
                source: "workspace".to_owned(),
                created_at: 1,
            }],
            &manifest,
        );

        assert_eq!(mapped.len(), 1);
        assert_eq!(mapped[0].source, "personal-notes");
        assert_eq!(mapped[0].source_label, "个人笔记");
        assert_eq!(mapped[0].path, "/notes/travel.md");
        assert!(!mapped[0].path.starts_with("/cache"));
        assert_eq!(mapped[0].start_line, 2);
        assert_eq!(mapped[0].end_line, 3);
    }
}
