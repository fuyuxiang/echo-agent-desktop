//! Structured, source-attributed memories. Markdown remains an editable legacy
//! source; the ledger is authoritative for new records and forgotten sources.
use crate::{storage::MemoryStorage, text_utils::strip_reasoning_blocks};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    io,
    path::{Path, PathBuf},
};

const MAX_LEDGER_BYTES: u64 = 8 * 1024 * 1024;
pub const RECORD_DOCUMENT: &str = "REMEMBERED.md";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecord {
    pub id: String,
    pub scope: String,
    pub kind: String,
    pub key: String,
    pub content: String,
    pub status: String,
    pub pinned: bool,
    pub origin: String,
    pub confidence: f64,
    pub sources: Vec<String>,
    pub evidence: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub valid_until: Option<i64>,
    pub revision: u64,
    #[serde(default)]
    pub observed_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordInput {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub evidence: String,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub valid_until: Option<i64>,
    #[serde(default)]
    pub expected_revision: Option<u64>,
    /// Supplied by the checkpoint, never by generated JSON.
    #[serde(skip)]
    pub observed_at: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryActivity {
    pub attempted_at: Option<i64>,
    pub succeeded_at: Option<i64>,
    pub outcome: String,
    pub detail: String,
    pub records_written: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalActivity {
    pub at: i64,
    pub mode: String,
    pub count: usize,
    pub sources: Vec<String>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Ledger {
    records: Vec<MemoryRecord>,
    forgotten: Vec<String>,
    replaced: Vec<String>,
    blocked_sessions: HashSet<String>,
}

pub fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Read settings on use, so turning memory off stops running sessions too.
/// A malformed settings file fails closed instead of silently enabling memory.
pub fn setting(section: &str, child: Option<&str>, key: &str, default: bool) -> bool {
    let path = echo_agent_config_home().join("config.toml");
    let raw = match std::fs::read_to_string(path) {
        Ok(value) => value,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return default,
        Err(_) => return false,
    };
    let Ok(config) = raw.parse::<toml::Value>() else {
        return false;
    };
    let mut value = config.get(section);
    if let Some(child) = child {
        value = value.and_then(|v| v.get(child));
    }
    value
        .and_then(|v| v.get(key))
        .and_then(toml::Value::as_bool)
        .unwrap_or(default)
}

fn echo_agent_config_home() -> PathBuf {
    echo_agent_tools::util::echo_agent_home::echo_agent_home()
}

fn read_json<T: serde::de::DeserializeOwned + Default>(path: &Path) -> io::Result<T> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(T::default()),
        Err(e) => return Err(e),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_LEDGER_BYTES
    {
        return Err(io::Error::other("invalid or oversized memory ledger"));
    }
    serde_json::from_slice(&std::fs::read(path)?).map_err(io::Error::other)
}

pub fn write_json(path: &Path, value: &impl Serialize) -> io::Result<()> {
    use std::io::Write;
    let bytes = serde_json::to_vec_pretty(value).map_err(io::Error::other)?;
    if bytes.len() as u64 > MAX_LEDGER_BYTES {
        return Err(io::Error::other("memory ledger is full"));
    }
    if std::fs::read(path).ok().as_deref() == Some(bytes.as_slice()) {
        return Ok(());
    }
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("invalid memory path"))?;
    std::fs::create_dir_all(parent)?;
    if std::fs::symlink_metadata(parent)?.file_type().is_symlink()
        || std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink() || !m.is_file())
    {
        return Err(io::Error::other("memory files cannot be symbolic links"));
    }
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    file.write_all(&bytes)?;
    file.as_file().sync_all()?;
    file.persist(path).map_err(|error| error.error)?;
    #[cfg(unix)]
    std::fs::File::open(parent)?.sync_all()?;
    Ok(())
}

fn root(storage: &MemoryStorage, scope: &str) -> io::Result<PathBuf> {
    for directory in [storage.global_dir(), storage.workspace_dir()] {
        if std::fs::symlink_metadata(directory)
            .is_ok_and(|m| m.file_type().is_symlink() || !m.is_dir())
        {
            return Err(io::Error::other(
                "memory directories must be real directories",
            ));
        }
    }
    match scope {
        "global" => Ok(storage.global_dir().to_owned()),
        "workspace" if !storage.is_ephemeral() => Ok(storage.workspace_dir().to_owned()),
        _ => Err(io::Error::other("请选择全局或持久工作区记忆")),
    }
}

fn load(storage: &MemoryStorage, scope: &str) -> io::Result<Ledger> {
    read_json(&root(storage, scope)?.join("records.json"))
}

fn lock_storage(storage: &MemoryStorage) -> io::Result<std::fs::File> {
    use fs2::FileExt;
    let dir = storage.global_dir();
    std::fs::create_dir_all(dir)?;
    if std::fs::symlink_metadata(dir)?.file_type().is_symlink() {
        return Err(io::Error::other("memory root cannot be a symbolic link"));
    }
    let path = dir.join(".records.lock");
    if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(io::Error::other("invalid memory lock"));
    }
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)?;
    file.lock_exclusive()?;
    Ok(file)
}

fn normalized(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

fn terms(text: &str) -> HashSet<String> {
    let mut values: HashSet<_> = crate::query_expansion::extract_keywords(text)
        .into_iter()
        .collect();
    values.extend(crate::query_expansion::extract_cjk_bigrams(text));
    values
}

fn related(a: &str, b: &str) -> bool {
    let na = normalized(a);
    let nb = normalized(b);
    if na.chars().count() >= 3 && (nb.contains(&na) || na.contains(&nb) && nb.chars().count() >= 3)
    {
        return true;
    }
    let ta = terms(a);
    let tb = terms(b);
    let common = ta.intersection(&tb).count();
    common >= 2 && common as f64 / ta.len().min(tb.len()).max(1) as f64 >= 0.65
}

fn save(storage: &MemoryStorage, scope: &str, ledger: &Ledger) -> io::Result<()> {
    let dir = root(storage, scope)?;
    // Commit truth first. Search filters against this ledger even if projection
    // writing fails; the next index refresh regenerates it.
    write_json(&dir.join("records.json"), ledger)?;
    let mut document = String::from("# Saved memories\n\n");
    for record in &ledger.records {
        if active(record) {
            document.push_str(&format!(
                "## {} · {}\n\n{}\n\nSource: {}\nUpdated: {}\n\n",
                record.kind,
                record.key,
                record.content,
                record.sources.join(", "),
                record.updated_at
            ));
        }
    }
    let path = dir.join(RECORD_DOCUMENT);
    if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink() || !m.is_file()) {
        return Err(io::Error::other("invalid memory projection"));
    }
    if std::fs::read_to_string(&path).ok().as_deref() == Some(document.as_str()) {
        return Ok(());
    }
    // This is a disposable projection. Its old contents must never become a
    // second source of forgotten/expired records.
    use std::io::Write;
    let mut file = tempfile::NamedTempFile::new_in(&dir)?;
    file.write_all(document.as_bytes())?;
    file.as_file().sync_all()?;
    file.persist(path).map_err(|error| error.error)?;
    Ok(())
}

pub fn active(record: &MemoryRecord) -> bool {
    record.status == "active" && record.valid_until.is_none_or(|until| until > now())
}

pub fn list(storage: &MemoryStorage, include_workspace: bool) -> io::Result<Vec<MemoryRecord>> {
    let mut records = load(storage, "global")?.records;
    if include_workspace
        && storage.workspace_dir() != storage.global_dir()
        && !storage.is_ephemeral()
    {
        records.extend(load(storage, "workspace")?.records);
    }
    records.sort_by_key(|r| (std::cmp::Reverse(r.pinned), std::cmp::Reverse(r.updated_at)));
    Ok(records)
}

pub fn source_blocked(storage: &MemoryStorage, session_id: &str) -> io::Result<bool> {
    for scope in ["global", "workspace"] {
        if scope == "workspace" && storage.is_ephemeral() {
            continue;
        }
        if load(storage, scope)?.blocked_sessions.contains(session_id) {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn permitted(storage: &MemoryStorage, content: &str) -> io::Result<bool> {
    for scope in ["global", "workspace"] {
        if scope == "workspace" && storage.is_ephemeral() {
            continue;
        }
        let ledger = load(storage, scope)?;
        if ledger
            .replaced
            .iter()
            .any(|old| normalized(content).contains(&normalized(old)))
        {
            return Ok(false);
        }
        if ledger.forgotten.iter().any(|topic| related(topic, content)) {
            return Ok(false);
        }
        if ledger.records.iter().any(|r| {
            if r.status == "forgotten" {
                related(&r.content, content)
            } else if !active(r) {
                normalized(content).contains(&normalized(&r.content))
            } else {
                false
            }
        }) {
            return Ok(false);
        }
    }
    Ok(true)
}

pub fn remember(
    storage: &MemoryStorage,
    mut input: RecordInput,
    source: Option<&str>,
    automatic: bool,
) -> io::Result<Option<MemoryRecord>> {
    input.content = strip_reasoning_blocks(&input.content).trim().to_owned();
    input.key = input.key.trim().to_owned();
    if !["user", "feedback", "project", "reference", "task"].contains(&input.kind.as_str())
        || input.content.is_empty()
        || input.content.chars().count() > 4000
        || input.key.is_empty()
        || input.key.chars().count() > 160
        || input.evidence.chars().count() > 2000
    {
        return Err(io::Error::other(
            "记忆需要有效的类型、主题和内容（最多 4000 字）",
        ));
    }
    if input.kind == "task" && input.valid_until.is_none() {
        input.valid_until = Some(now() + 30 * 86400);
    }
    let _guard = crate::storage::memory_mutation_lock()
        .lock()
        .map_err(|_| io::Error::other("memory lock poisoned"))?;
    let _file_lock = lock_storage(storage)?;
    if automatic && !setting("memory", None, "enabled", true) {
        return Ok(None);
    }
    if automatic
        && (source.is_some_and(|sid| source_blocked(storage, sid).unwrap_or(true))
            || !permitted(storage, &format!("{} {}", input.key, input.content))?)
    {
        return Ok(None);
    }
    let mut ledger = load(storage, &input.scope)?;
    let existing = if let Some(id) = &input.id {
        Some(
            ledger
                .records
                .iter()
                .position(|r| &r.id == id)
                .ok_or_else(|| io::Error::other("记忆已被删除，请刷新"))?,
        )
    } else {
        ledger
            .records
            .iter()
            .position(|r| normalized(&r.key) == normalized(&input.key) && r.kind == input.kind)
    };
    if let Some(index) = existing {
        if ledger.records.iter().enumerate().any(|(other, r)| {
            other != index && r.kind == input.kind && normalized(&r.key) == normalized(&input.key)
        }) {
            return Err(io::Error::other("已有同主题和类型的记忆，请更正原条目"));
        }
        let previous = &mut ledger.records[index];
        if automatic && input.observed_at.unwrap_or_else(now) < previous.observed_at {
            return Ok(None);
        }
        if input
            .expected_revision
            .is_some_and(|rev| rev != previous.revision)
        {
            return Err(io::Error::other("记忆已被其他会话修改，请刷新后重试"));
        }
        if automatic
            && (previous.pinned || previous.origin == "manual" || previous.status != "active")
        {
            return Ok(None);
        }
        let new_source = source.filter(|s| !previous.sources.iter().any(|old| old == s));
        if previous.content == input.content
            && previous.valid_until == input.valid_until
            && previous.key == input.key
            && previous.kind == input.kind
            && previous.pinned == input.pinned
            && previous.status == "active"
            && (automatic || previous.origin == "manual")
            && new_source.is_none()
            && (!automatic || previous.observed_at == input.observed_at.unwrap_or_else(now))
        {
            return Ok(if automatic {
                None
            } else {
                Some(previous.clone())
            });
        }
        // Old facts are excluded from legacy summaries and historical reads too.
        if previous.content != input.content {
            ledger.replaced.push(previous.content.clone());
        }
        previous.content = input.content;
        previous.key = input.key;
        previous.kind = input.kind;
        previous.evidence = input.evidence;
        previous.updated_at = now();
        previous.observed_at = input.observed_at.unwrap_or_else(now);
        previous.revision += 1;
        previous.status = "active".into();
        previous.valid_until = input.valid_until;
        previous.pinned = input.pinned;
        if !automatic {
            previous.origin = "manual".into();
        }
        if let Some(source) = source {
            if !previous.sources.iter().any(|s| s == source) {
                previous.sources.push(source.to_owned());
            }
        }
        let result = previous.clone();
        save(storage, &input.scope, &ledger)?;
        return Ok(Some(result));
    }
    if ledger.records.len() >= 10_000 {
        return Err(io::Error::other("记忆条目已满，请先整理"));
    }
    let timestamp = now();
    let id = blake3::hash(
        format!(
            "{}:{}:{}:{}",
            input.scope,
            input.kind,
            normalized(&input.key),
            ledger.records.len()
        )
        .as_bytes(),
    )
    .to_hex()[..24]
        .to_owned();
    let record = MemoryRecord {
        id,
        scope: input.scope.clone(),
        kind: input.kind,
        key: input.key,
        content: input.content,
        status: "active".into(),
        pinned: input.pinned,
        origin: if automatic { "automatic" } else { "manual" }.into(),
        confidence: if automatic { 0.85 } else { 1.0 },
        sources: source.into_iter().map(str::to_owned).collect(),
        evidence: input.evidence,
        created_at: timestamp,
        updated_at: timestamp,
        valid_until: input.valid_until,
        revision: 1,
        observed_at: input.observed_at.unwrap_or(timestamp),
    };
    ledger.records.push(record.clone());
    save(storage, &input.scope, &ledger)?;
    Ok(Some(record))
}

/// Forgetting keeps a small exclusion rule, never the original content as an
/// active memory. Known source conversations cannot silently teach it again.
pub fn retire(
    storage: &MemoryStorage,
    scope: &str,
    id: &str,
    revision: Option<u64>,
    completed: bool,
) -> io::Result<()> {
    retire_with_policy(storage, scope, id, revision, completed, false)
}

fn retire_with_policy(
    storage: &MemoryStorage,
    scope: &str,
    id: &str,
    revision: Option<u64>,
    completed: bool,
    automatic: bool,
) -> io::Result<()> {
    let _guard = crate::storage::memory_mutation_lock()
        .lock()
        .map_err(|_| io::Error::other("memory lock poisoned"))?;
    let _file_lock = lock_storage(storage)?;
    if automatic && !setting("memory", None, "enabled", true) {
        return Ok(());
    }
    let mut ledger = load(storage, scope)?;
    let record = ledger
        .records
        .iter_mut()
        .find(|r| r.id == id)
        .ok_or_else(|| io::Error::other("记忆不存在"))?;
    if revision.is_some_and(|rev| rev != record.revision) {
        return Err(io::Error::other("记忆已变更，请刷新"));
    }
    if !completed {
        ledger.forgotten.push(record.content.clone());
        ledger.forgotten.push(record.key.clone());
        ledger
            .blocked_sessions
            .extend(record.sources.iter().cloned());
    }
    record.status = if completed { "completed" } else { "forgotten" }.into();
    record.updated_at = now();
    record.revision += 1;
    save(storage, scope, &ledger)
}

pub fn forget_topic(storage: &MemoryStorage, scope: &str, topic: &str) -> io::Result<usize> {
    if topic.trim().chars().count() < 2 || topic.chars().count() > 4000 {
        return Err(io::Error::other("请提供明确的遗忘内容"));
    }
    let _guard = crate::storage::memory_mutation_lock()
        .lock()
        .map_err(|_| io::Error::other("memory lock poisoned"))?;
    let _file_lock = lock_storage(storage)?;
    let mut ledger = load(storage, scope)?;
    let mut count = 0;
    for record in &mut ledger.records {
        if active(record) && (related(topic, &record.key) || related(topic, &record.content)) {
            ledger
                .blocked_sessions
                .extend(record.sources.iter().cloned());
            record.status = "forgotten".into();
            record.updated_at = now();
            record.revision += 1;
            count += 1;
        }
    }
    ledger.forgotten.push(topic.trim().to_owned());
    save(storage, scope, &ledger)?;
    Ok(count)
}

pub fn forget_source(storage: &MemoryStorage, session_id: &str) -> io::Result<usize> {
    let _guard = crate::storage::memory_mutation_lock()
        .lock()
        .map_err(|_| io::Error::other("memory lock poisoned"))?;
    let _file_lock = lock_storage(storage)?;
    let mut count = 0;
    for scope in ["global", "workspace"] {
        if scope == "workspace" && storage.is_ephemeral() {
            continue;
        }
        let mut ledger = load(storage, scope)?;
        ledger.blocked_sessions.insert(session_id.to_owned());
        for record in &mut ledger.records {
            if active(record) && record.sources.iter().any(|s| s == session_id) {
                record.status = "forgotten".into();
                record.updated_at = now();
                record.revision += 1;
                ledger.forgotten.push(record.content.clone());
                count += 1;
            }
        }
        save(storage, scope, &ledger)?;
    }
    Ok(count)
}

pub fn source_path_blocked(storage: &MemoryStorage, path: &Path) -> io::Result<bool> {
    let Some(stem) = path.file_stem().and_then(|name| name.to_str()) else {
        return Ok(false);
    };
    for scope in ["global", "workspace"] {
        if scope == "workspace" && storage.is_ephemeral() {
            continue;
        }
        if load(storage, scope)?.blocked_sessions.iter().any(|sid| {
            sid.chars().count() >= 8 && stem.ends_with(&sid.chars().take(8).collect::<String>())
        }) {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn core_context(storage: &MemoryStorage) -> io::Result<String> {
    let mut context = String::new();
    for record in list(storage, true)?.iter().filter(|r| {
        active(r) && (r.pinned || r.kind == "user" || r.kind == "feedback" || r.kind == "task")
    }) {
        let line = format!(
            "- [{} / {} / {}] {}: {}\n",
            record.id, record.scope, record.kind, record.key, record.content
        );
        if context.chars().count() + line.chars().count() > 6000 {
            continue;
        }
        context.push_str(&line);
    }
    // Existing global documents were maintained explicitly before records
    // existed. Keep their preferences available during migration too.
    if let Ok(legacy) = std::fs::read_to_string(storage.global_memory_file()) {
        if !crate::dream::is_scaffold_template(&legacy) {
            let remaining = 8000usize.saturating_sub(context.chars().count());
            let mut legacy_context = String::new();
            for paragraph in legacy.split("\n\n") {
                if permitted(storage, paragraph)? {
                    legacy_context.push_str(paragraph);
                    legacy_context.push_str("\n\n");
                }
            }
            context.extend(legacy_context.chars().take(remaining));
        }
    }
    Ok(context)
}

pub fn refresh_documents(storage: &MemoryStorage) -> io::Result<()> {
    let _guard = crate::storage::memory_mutation_lock()
        .lock()
        .map_err(|_| io::Error::other("memory lock poisoned"))?;
    let _file_lock = lock_storage(storage)?;
    for scope in ["global", "workspace"] {
        if scope == "workspace"
            && (storage.is_ephemeral() || storage.workspace_dir() == storage.global_dir())
        {
            continue;
        }
        let ledger = load(storage, scope)?;
        if !ledger.records.is_empty() {
            save(storage, scope, &ledger)?;
        }
    }
    Ok(())
}

pub fn activity(storage: &MemoryStorage) -> MemoryActivity {
    read_json(&storage.workspace_dir().join("activity.json")).unwrap_or_default()
}
pub fn set_activity(storage: &MemoryStorage, value: &MemoryActivity) -> io::Result<()> {
    write_json(&storage.workspace_dir().join("activity.json"), value)
}
pub fn retrieval(storage: &MemoryStorage) -> RetrievalActivity {
    read_json(&storage.workspace_dir().join("retrieval.json")).unwrap_or_default()
}
pub fn set_retrieval(storage: &MemoryStorage, value: &RetrievalActivity) {
    let _ = write_json(&storage.workspace_dir().join("retrieval.json"), value);
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Extraction {
    pub memories: Vec<RecordInput>,
    #[serde(default)]
    pub completed_keys: Vec<CompletedTask>,
}

#[derive(Debug, Deserialize)]
pub struct CompletedTask {
    pub key: String,
    pub scope: String,
    pub evidence: String,
}

/// A generated quote must actually occur in the supplied conversation. This
/// also prevents accidentally storing the model's private reasoning as fact.
pub fn grounded_extraction(json: &str, source_text: &str) -> io::Result<String> {
    let mut value: serde_json::Value = serde_json::from_str(json).map_err(io::Error::other)?;
    let source: String = source_text.chars().filter(|c| !c.is_whitespace()).collect();
    let supported = |memory: &serde_json::Value| {
        let quote: String = memory
            .get("evidence")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        quote.chars().count() >= 4 && source.contains(&quote)
    };
    value
        .get_mut("memories")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or_else(|| io::Error::other("invalid memory extraction"))?
        .retain(&supported);
    if let Some(completed) = value
        .get_mut("completedKeys")
        .and_then(serde_json::Value::as_array_mut)
    {
        completed.retain(supported);
    }
    serde_json::to_string(&value).map_err(io::Error::other)
}

pub fn extraction_context(storage: &MemoryStorage) -> io::Result<String> {
    let mut output = String::new();
    for record in list(storage, true)? {
        let line = serde_json::json!({ "id": record.id, "scope": record.scope, "kind": record.kind, "key": record.key, "content": record.content, "status": record.status, "pinned": record.pinned }).to_string();
        if output.chars().count() + line.chars().count() > 24_000 {
            continue;
        }
        output.push_str(&line);
        output.push('\n');
    }
    Ok(output)
}

pub fn apply_extraction(storage: &MemoryStorage, json: &str, source: &str) -> io::Result<String> {
    apply_extraction_at(storage, json, source, now())
}

pub fn apply_extraction_at(
    storage: &MemoryStorage,
    json: &str,
    source: &str,
    observed_at: i64,
) -> io::Result<String> {
    let extraction: Extraction = serde_json::from_str(json).map_err(io::Error::other)?;
    if extraction.memories.len() > 20 || extraction.completed_keys.len() > 20 {
        return Err(io::Error::other("too many extracted memories"));
    }
    if source_blocked(storage, source)? {
        return Ok(String::new());
    }
    let mut summary = String::new();
    let mut written = 0;
    for mut input in extraction.memories {
        input.id = None;
        input.expected_revision = None;
        input.pinned = false;
        input.observed_at = Some(observed_at);
        if input.evidence.trim().is_empty() {
            continue;
        }
        if let Some(record) = remember(storage, input, Some(source), true)? {
            summary.push_str(&format!("## {}\n\n{}\n\n", record.key, record.content));
            written += 1;
        }
    }
    for completion in extraction.completed_keys {
        if completion.evidence.trim().is_empty() {
            continue;
        }
        for record in list(storage, true)?.into_iter().filter(|r| {
            active(r)
                && r.kind == "task"
                && r.key == completion.key
                && r.scope == completion.scope
                && r.observed_at <= observed_at
        }) {
            retire_with_policy(
                storage,
                &record.scope,
                &record.id,
                Some(record.revision),
                true,
                true,
            )?;
            summary.push_str(&format!("## 已完成\n\n{}\n\n", record.key));
        }
    }
    set_activity(
        storage,
        &MemoryActivity {
            attempted_at: Some(now()),
            succeeded_at: Some(now()),
            outcome: if written > 0 { "saved" } else { "unchanged" }.into(),
            detail: String::new(),
            records_written: written,
        },
    )?;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(scope: &str, content: &str) -> RecordInput {
        RecordInput {
            scope: scope.into(),
            kind: "user".into(),
            key: "response style".into(),
            content: content.into(),
            ..Default::default()
        }
    }
    #[test]
    fn correction_forgetting_and_source_deletion_survive_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let storage =
            MemoryStorage::with_paths(temp.path().join("global"), temp.path().join("workspace"));
        let first = remember(&storage, input("global", "回答先给结论"), Some("s1"), true)
            .unwrap()
            .unwrap();
        let mut corrected = input("global", "回答要给详细过程");
        corrected.id = Some(first.id.clone());
        corrected.expected_revision = Some(first.revision);
        let second = remember(&storage, corrected, None, false).unwrap().unwrap();
        assert_eq!(second.revision, 2);
        assert_eq!(
            remember(&storage, input("global", "回答先给结论"), Some("s2"), true).unwrap(),
            None
        );
        retire(&storage, "global", &first.id, Some(2), false).unwrap();
        assert!(core_context(&storage).unwrap().is_empty());
        assert!(source_blocked(&storage, "s1").unwrap());
        assert!(!permitted(&storage, "回答要给详细过程").unwrap());
    }
    #[test]
    fn workspace_isolation_and_expiration() {
        let temp = tempfile::tempdir().unwrap();
        let a = MemoryStorage::with_paths(temp.path().join("global"), temp.path().join("a"));
        let b = MemoryStorage::with_paths(temp.path().join("global"), temp.path().join("b"));
        remember(&a, input("workspace", "只属于项目 A"), Some("s1"), true).unwrap();
        assert_eq!(list(&a, true).unwrap().len(), 1);
        assert!(list(&b, true).unwrap().is_empty());
        let mut task = input("workspace", "明天提交初稿");
        task.kind = "task".into();
        task.key = "初稿".into();
        task.valid_until = Some(now() - 1);
        remember(&a, task, Some("s1"), true).unwrap();
        assert!(!core_context(&a).unwrap().contains("明天"));
        assert_eq!(forget_source(&a, "s1").unwrap(), 1);
        assert!(core_context(&a).unwrap().is_empty());
    }
}
