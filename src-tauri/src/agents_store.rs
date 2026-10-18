//! Experts / Assistants — read & write EchoAgent's agent definition files.
//!
//! EchoAgent discovers "agents" (subagent definitions — see
//! `echo-agent-core/src/discovery.rs`) by scanning:
//!   - project: `<cwd>/.echo-agent/agents/*.md` and `<cwd>/.claude/agents/*.md`
//!     (walking up to the git worktree root)
//!   - user: `~/.echo-agent/agents/*.md`
//!
//! Each file is markdown with YAML frontmatter (the `AgentDefinition` fields
//! from `echo-agent-core/src/config.rs:714`) plus a body used as the system
//! prompt. EchoAgent does NOT expose an `echo.agent/agents/*` ACP method, so we read and
//! write these files directly — there's no in-memory state to race with
//! (EchoAgent's file watcher picks up changes on its own).
//!
//! EchoAgent cannot switch the active session's agent (ACP has no such call),
//! but the user can launch a new session guided by an agent's prompt, or
//! spawn the agent via EchoAgent's `spawn_subagent` tool from within a chat.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use fs2::FileExt;
use tauri::State;

const MAX_AGENT_FILE_BYTES: u64 = 1024 * 1024;
const MAX_AGENT_FILES: usize = 256;
const MAX_SCANNED_DIRECTORY_ENTRIES: usize = 1024;
const MAX_AGENT_NAME_CHARS: usize = 256;
const MAX_AGENT_DESCRIPTION_CHARS: usize = 4_096;
const MAX_AGENT_MODEL_TAGS: usize = 16;
const MAX_TRUSTED_LOCAL_AGENTS: usize = 512;

static TRUSTED_LOCAL_AGENTS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static AGENT_WRITES: Mutex<()> = Mutex::new(());

fn trusted_local_agents() -> &'static Mutex<HashSet<String>> {
    TRUSTED_LOCAL_AGENTS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn remember_local_agents(agents: &[AgentEntry]) -> Result<(), String> {
    let mut trusted = trusted_local_agents()
        .lock()
        .map_err(|_| "本地专家授权状态已损坏".to_string())?;
    for agent in agents {
        if trusted.contains(&agent.name) {
            continue;
        }
        if trusted.len() >= MAX_TRUSTED_LOCAL_AGENTS {
            return Err(format!(
                "本次运行最多加载 {MAX_TRUSTED_LOCAL_AGENTS} 个本地专家"
            ));
        }
        trusted.insert(agent.name.clone());
    }
    Ok(())
}

pub(crate) fn require_listed_local_expert(
    expert_id: &str,
    expert_name: &str,
    avatar_local: Option<&str>,
) -> Result<crate::meta::ExpertBinding, String> {
    if avatar_local.is_some() || expert_id != expert_name {
        return Err("本地专家元数据与后端列表不一致".into());
    }
    let trusted = trusted_local_agents()
        .lock()
        .map_err(|_| "本地专家授权状态已损坏".to_string())?;
    if !trusted.contains(expert_id) {
        return Err("本地专家尚未由后端列表加载".into());
    }
    Ok(crate::meta::ExpertBinding {
        expert_id: expert_id.to_string(),
        expert_name: expert_name.to_string(),
        source: "local".into(),
        avatar_local: None,
    })
}

/// One agent definition, as surfaced to the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEntry {
    /// Agent name (from frontmatter `name`, falling back to the file stem).
    pub name: String,
    /// Short description (frontmatter `description`).
    #[serde(default)]
    pub description: Option<String>,
    /// Where the file lives: "user" (`~/.echo-agent/agents/`) or "project"
    /// (`<cwd>/.echo-agent/agents/`).
    pub scope: String,
    /// Absolute path to the `.md` file.
    pub path: String,
    /// Full file contents (frontmatter + body), for the editor view.
    pub raw: String,
    /// Avatar preset index (1-20). Mirrors EchoAgent's CreateColleagueDialog
    /// avatar presets. Stored in frontmatter as `avatar: <n>`. 0/None = use
    /// the name-initial fallback.
    #[serde(default)]
    pub avatar: Option<u32>,
    /// Model capability tags: subset of ["default", "multimodal", "reasoning"].
    /// Stored in frontmatter as `model_tags: [a, b]` (comma-separated also ok).
    /// Used by the assistant card to show capability badges.
    #[serde(default)]
    pub model_tags: Vec<String>,
}

/// Parsed YAML frontmatter (only the fields we display). Unknown keys are
/// ignored — `AgentDefinition` has ~30 fields, we only need a few for the UI.
#[derive(Debug, Default, Deserialize)]
struct AgentFrontmatter {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    avatar: Option<u32>,
    #[serde(default)]
    model_tags: Vec<String>,
}

fn user_agents_dir() -> PathBuf {
    crate::paths::echo_agent_home_dir().join("agents")
}

fn resolve_user_agent_path(path: &str) -> Result<PathBuf, String> {
    let root = user_agents_dir();
    std::fs::create_dir_all(&root).map_err(|e| format!("create agents dir: {e}"))?;
    let root = root
        .canonicalize()
        .map_err(|e| format!("resolve agents dir: {e}"))?;
    let requested = PathBuf::from(path);
    if std::fs::symlink_metadata(&requested)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("拒绝访问符号链接 Agent 文件".into());
    }
    let candidate = requested
        .canonicalize()
        .map_err(|e| format!("resolve agent path: {e}"))?;
    if candidate.parent() != Some(root.as_path())
        || candidate.extension().and_then(|value| value.to_str()) != Some("md")
    {
        return Err("拒绝访问用户 Agent 目录之外的路径".into());
    }
    Ok(candidate)
}

fn read_agent_file(path: &Path) -> Result<String, String> {
    // Keep the directory scan's symlink check, but enforce it again at open:
    // another process can replace the entry between canonicalization and read.
    let bytes = crate::shell_fs::read_regular_file_bounded(path, MAX_AGENT_FILE_BYTES).map_err(
        |error| {
            if error.contains("安全上限") {
                format!(
                    "Agent 定义不能超过 {} MB",
                    MAX_AGENT_FILE_BYTES / 1024 / 1024
                )
            } else {
                format!("read {}: {error}", path.display())
            }
        },
    )?;
    String::from_utf8(bytes).map_err(|error| format!("Agent 定义不是有效 UTF-8：{error}"))
}

/// User-scope agents directory used by the local team collaboration tools.
pub fn user_agents_dir_pub() -> PathBuf {
    user_agents_dir()
}

/// Scan one directory for `*.md` agent files. Best-effort: unreadable entries
/// are skipped.
fn scan_dir(dir: &Path, scope: &str) -> Vec<AgentEntry> {
    let mut out = Vec::new();
    let Ok(root) = dir.canonicalize() else {
        return out;
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    let mut paths = entries
        .flatten()
        .take(MAX_SCANNED_DIRECTORY_ENTRIES)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            if !file_type.is_file() || file_type.is_symlink() {
                return None;
            }
            let path = entry.path().canonicalize().ok()?;
            if path.parent() != Some(root.as_path()) {
                return None;
            }
            (path.extension().and_then(|extension| extension.to_str()) == Some("md"))
                .then_some(path)
        })
        .collect::<Vec<_>>();
    paths.sort();
    paths.truncate(MAX_AGENT_FILES);
    for path in paths {
        let Ok(raw) = read_agent_file(&path) else {
            continue;
        };
        let fm = parse_frontmatter(&raw);
        let name = fm
            .name
            .clone()
            .or_else(|| path.file_stem().and_then(|n| n.to_str()).map(String::from))
            .unwrap_or_else(|| "unnamed".into());
        out.push(AgentEntry {
            name,
            description: fm.description.clone(),
            scope: scope.to_string(),
            path: path.to_string_lossy().into_owned(),
            avatar: fm.avatar,
            model_tags: fm.model_tags.clone(),
            raw,
        });
    }
    out
}

/// Extract the YAML frontmatter block (`---\n...\n---`) and parse the few
/// fields we care about. Returns defaults if the block is absent or malformed
/// — we never fail the whole scan on one bad file.
fn parse_frontmatter(raw: &str) -> AgentFrontmatter {
    let raw = raw.trim_start();
    if !raw.starts_with("---") {
        return AgentFrontmatter::default();
    }
    // Skip the opening `---` line.
    let after_open = match raw.find('\n') {
        Some(i) => &raw[i + 1..],
        None => return AgentFrontmatter::default(),
    };
    // Find the closing `---` on its own line.
    let end = after_open
        .find("\n---")
        .or_else(|| after_open.find("\r\n---"));
    let block = match end {
        Some(i) => &after_open[..i],
        None => return AgentFrontmatter::default(),
    };
    // Minimal YAML parse: only `key: value` lines for the fields we display.
    // We avoid pulling in a YAML crate for this — the agent frontmatter we
    // care about is flat and simple. `model_tags` may appear as
    // `model_tags: [a, b]` (inline array) or `model_tags: a, b` (csv).
    let mut fm = AgentFrontmatter::default();
    for line in block.lines() {
        if line.chars().next().is_some_and(char::is_whitespace) { continue; }
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let k = k.trim();
        let v = v.trim();
        match k {
            "name" => {
                let parsed = parse_scalar(v);
                if !parsed.is_empty() {
                    fm.name = Some(parsed);
                }
            }
            "description" => {
                let parsed = parse_scalar(v);
                if !parsed.is_empty() {
                    fm.description = Some(parsed);
                }
            }
            "avatar" => {
                if let Ok(n) = v.parse::<u32>() {
                    fm.avatar = Some(n);
                }
            }
            "model_tags" => {
                let list = if v.starts_with('[') && v.ends_with(']') {
                    // Inline YAML array: strip brackets, split on comma.
                    v[1..v.len() - 1]
                        .split(',')
                        .map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string())
                        .filter(|s| !s.is_empty())
                        .collect::<Vec<_>>()
                } else if v.is_empty() {
                    Vec::new()
                } else {
                    // CSV form.
                    v.split(',')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect::<Vec<_>>()
                };
                fm.model_tags = list;
            }
            _ => {}
        }
    }
    // Runtime owns YAML semantics (including block scalars); nested advanced
    // keys must never overwrite the displayed top-level identity.
    if let Ok(definition) = echo_agent_core::AgentDefinition::parse(raw) {
        fm.name = Some(definition.name);
        fm.description = Some(definition.description);
    }
    fm
}

/// List all agent definitions visible to EchoAgent. Combines user-scope and
/// project-scope (for the given cwd), using the Runtime's effective identity.
fn collect_agents(cwd: Option<&str>) -> Vec<AgentEntry> {
    if let Some(cwd) = cwd {
        // Use exactly the runtime resolver, including project ancestors,
        // compatibility directories and built-in shadowing rules.
        let root = Path::new(cwd);
        return echo_agent_core::discovery::all_subagents(root, &Default::default())
            .into_iter()
            .filter_map(|entry| {
                let definition = echo_agent_core::discovery::by_name_in_cwd(&entry.name, root)?;
                let path = definition.source_path?;
                let raw = read_agent_file(&path).ok()?;
                let fm = parse_frontmatter(&raw);
                Some(AgentEntry {
                    name: entry.name,
                    description: Some(definition.description),
                    scope: match definition.scope {
                        echo_agent_core::config::AgentScope::Project => "project",
                        echo_agent_core::config::AgentScope::User => "user",
                        _ => "bundled",
                    }.into(),
                    path: path.to_string_lossy().into_owned(), raw,
                    avatar: fm.avatar, model_tags: fm.model_tags,
                })
            }).take(MAX_AGENT_FILES).collect();
    }
    let mut out = scan_dir(&user_agents_dir(), "user");
    // Global management shows user definitions, independent of workspace overrides.
    let mut seen = std::collections::HashSet::new();
    out.retain(|a| seen.insert(a.name.clone()));
    out.truncate(MAX_AGENT_FILES);
    out
}

pub(crate) fn team_agents() -> Vec<AgentEntry> {
    collect_agents(None)
}

pub(crate) fn require_runtime_identity(name: &str, expected: &Path, cwd: &Path) -> Result<(), String> {
    let actual = echo_agent_core::discovery::by_name_in_cwd(name, cwd)
        .and_then(|definition| definition.source_path)
        .and_then(|path| path.canonicalize().ok());
    let expected = expected.canonicalize().map_err(|_| format!("专家“{name}”定义已不存在，请重新选择"))?;
    if actual.as_deref() != Some(expected.as_path()) {
        return Err(format!("专家“{name}”在当前工作区由另一份定义生效。请在团队中重新选择当前可用的专家，或更改冲突名称；未派发工作"));
    }
    Ok(())
}

pub(crate) fn require_expert_snapshot(cwd: &Path, name: &str, path: &str, expected_raw: &str) -> Result<(), String> {
    require_runtime_identity(name, Path::new(path), cwd)?;
    if read_agent_file(Path::new(path))? != expected_raw { return Err("专家配置已更新，请重新选择后发送；本次消息尚未发送".into()); }
    Ok(())
}

#[derive(Deserialize)]
pub struct ExpertReference { id: String, name: String }

/// Reject stale project references instead of silently delegating to a new
/// definition with the same display name.
#[tauri::command]
pub fn agents_validate_references(access: State<'_, crate::shell_fs::FilesystemAccess>, cwd: String, references: Vec<ExpertReference>) -> Result<(), String> {
    let cwd = access.require_workspace(&cwd)?;
    if references.len() > MAX_AGENT_FILES { return Err("项目专家引用过多".into()); }
    for reference in references {
        if !Path::new(&reference.id).is_absolute() { return Err(format!("项目专家“{}”是旧版引用，请移除后重新选择", reference.name)); }
        require_runtime_identity(&reference.name, Path::new(&reference.id), &cwd)?;
    }
    Ok(())
}

pub(crate) fn agent_definition_name(path: &Path) -> Result<String, String> {
    let raw = read_agent_file(path)?;
    parse_frontmatter(&raw)
        .name
        .or_else(|| {
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .map(str::to_owned)
        })
        .ok_or_else(|| "专家定义缺少名称".into())
}

#[tauri::command]
pub fn agents_list(
    access: State<'_, crate::shell_fs::FilesystemAccess>,
    cwd: Option<String>,
) -> Result<Vec<AgentEntry>, String> {
    let cwd = match cwd.filter(|value| !value.trim().is_empty()) {
        Some(value) => Some(
            access
                .require_workspace(&value)?
                .to_string_lossy()
                .into_owned(),
        ),
        None => None,
    };
    let agents = collect_agents(cwd.as_deref());
    remember_local_agents(&agents)?;
    Ok(agents)
}

pub fn markdown_body(raw: &str) -> String {
    let trimmed = raw.trim_start();
    if !trimmed.starts_with("---") {
        return raw.trim().to_string();
    }
    let Some(after_open) = trimmed.find('\n') else {
        return raw.trim().to_string();
    };
    let rest = &trimmed[after_open + 1..];
    let Some(close_start) = rest.find("\n---\n").or_else(|| rest.find("\r\n---\r\n")) else {
        return raw.trim().to_string();
    };
    let marker_len = if rest[close_start..].starts_with("\r\n---\r\n") {
        7
    } else {
        5
    };
    rest[close_start + marker_len..].trim().to_string()
}

/// Merge only the fields owned by the simple editor. Native YAML parsing uses
/// the same semantics as Runtime, including quoted keys, aliases and CRLF.
/// Invalid originals are never replaced by a fresh template.
#[tauri::command]
pub fn agents_merge_definition(original_raw: String, generated_raw: String) -> Result<String, String> {
    merge_expert_definition(&original_raw, &generated_raw)
}

fn definition_yaml(raw: &str) -> Result<serde_yaml::Mapping, String> {
    if raw.len() as u64 > MAX_AGENT_FILE_BYTES { return Err("专家配置不能超过1MB，原配置未修改".into()); }
    echo_agent_core::AgentDefinition::parse(raw)
        .map_err(|error| format!("无法安全合并专家配置，原配置未修改：{error}"))?;
    let content = raw.trim_start().strip_prefix("---").ok_or("专家配置缺少 frontmatter")?;
    let close = content.find("\n---").ok_or("专家配置缺少结束标记")?;
    serde_yaml::from_str(&content[..close])
        .map_err(|error| format!("无法安全读取专家配置，原配置未修改：{error}"))
}

fn merge_expert_definition(original: &str, generated: &str) -> Result<String, String> {
    let mut mapping = definition_yaml(original)?;
    let mut replacement = definition_yaml(generated)?;
    for field in ["name", "description", "avatar", "model_tags"] {
        let key = serde_yaml::Value::String(field.into());
        mapping.remove(&key);
        if let Some(value) = replacement.remove(&key) { mapping.insert(key, value); }
    }
    let yaml = serde_yaml::to_string(&mapping).map_err(|error| error.to_string())?;
    let result = format!("---\n{yaml}---\n\n{}", markdown_body(generated));
    echo_agent_core::AgentDefinition::parse(&result)
        .map_err(|error| format!("合并后的专家配置无效，原配置未修改：{error}"))?;
    Ok(result)
}

/// Fetch a single agent file's full contents.
#[tauri::command]
pub fn agents_get(path: String) -> Result<String, String> {
    let safe = resolve_user_agent_path(&path)?;
    read_agent_file(&safe)
}

/// Create a user-scope agent without overwriting an existing definition.
/// Updates use `agents_update` with an exact path and expected original bytes.
/// The caller supplies the full markdown body (frontmatter + prompt).
#[tauri::command]
pub fn agents_save(name: String, raw: String) -> Result<AgentEntry, String> {
    save_agent_at(&user_agents_dir(), &name, raw, None)
}

/// Update an exact definition using optimistic concurrency. Display-name
/// changes keep the file identity stable: one atomic replace, no delete-old gap.
#[tauri::command]
pub fn agents_update(path: String, expected_raw: String, raw: String) -> Result<AgentEntry, String> {
    let path = resolve_user_agent_path(&path)?;
    let name = parse_frontmatter(&raw).name.ok_or("专家定义缺少名称")?;
    save_agent_at(&user_agents_dir(), &name, raw, Some((&path, &expected_raw)))
}

fn save_agent_at(root: &Path, name: &str, raw: String, previous: Option<(&Path, &str)>) -> Result<AgentEntry, String> {
    save_agent_with_registry_at(root, name, raw, previous, trusted_local_agents(), MAX_TRUSTED_LOCAL_AGENTS)
}

fn save_agent_with_registry_at(root: &Path, name: &str, raw: String, previous: Option<(&Path, &str)>, registry: &Mutex<HashSet<String>>, registry_limit: usize) -> Result<AgentEntry, String> {
    let _guard = AGENT_WRITES.lock().map_err(|_| "专家存储锁已损坏")?;
    // Only a blank name is rejected. The slug is derived separately and always
    // resolves to something writable, so a valid display name in any script
    // (e.g. "代码专家") can be saved.
    if name.trim().is_empty() {
        return Err("助理名称不能为空".into());
    }
    if name.chars().count() > MAX_AGENT_NAME_CHARS {
        return Err(format!("助理名称不能超过 {MAX_AGENT_NAME_CHARS} 个字符"));
    }
    let safe_name = slug_for_agent(name);
    if raw.len() as u64 > MAX_AGENT_FILE_BYTES {
        return Err("Agent 定义不能超过 1 MB".into());
    }
    let dir = root.to_path_buf();
    std::fs::create_dir_all(&dir).map_err(|e| format!("create agents dir: {e}"))?;
    if std::fs::symlink_metadata(&dir).map_err(|e| e.to_string())?.file_type().is_symlink() {
        return Err("专家目录不能是符号链接".into());
    }
    let lock = std::fs::OpenOptions::new().read(true).write(true).create(true)
        .truncate(false).open(dir.join(".write.lock")).map_err(|e| e.to_string())?;
    lock.lock_exclusive().map_err(|e| e.to_string())?;
    let root = dir.canonicalize().map_err(|e| e.to_string())?;
    let mut path = previous.map(|(path, _)| path.to_path_buf())
        .unwrap_or_else(|| root.join(format!("{safe_name}.md")));
    let fm = parse_frontmatter(&raw);
    if fm.name.as_deref() != Some(name.trim()) || name.chars().any(char::is_control) {
        return Err("专家名称与定义不一致或含控制字符".into());
    }
    // The parser also validates advanced fields retained by the editor.
    echo_agent_core::AgentDefinition::parse(&raw).map_err(|e| format!("专家配置无效：{e}"))?;
    if let Some((original, expected)) = previous {
        if original.parent() != Some(root.as_path()) || read_agent_file(original)? != expected {
            return Err("专家配置已被其他操作修改，请重新打开后再保存".into());
        }
    }
    for existing in scan_dir(&root, "user") {
        if previous.is_some_and(|(original, _)| Path::new(&existing.path) == original) { continue; }
        if existing.name.trim().to_lowercase() == name.trim().to_lowercase()
            || slug_for_agent(&existing.name).to_lowercase() == safe_name.to_lowercase()
            {
            return Err(format!("专家“{}”已存在，请使用其他名称；已有配置未修改", existing.name));
        }
    }
    // Hold the registry reservation through publication. Any fallible lock or
    // capacity check happens before disk commit; a saved file must not be
    // reported as failed only because its UI binding cannot be remembered.
    let mut trusted = registry.lock().map_err(|_| "本地专家授权状态已损坏")?;
    if !trusted.contains(name.trim()) && trusted.len() >= registry_limit {
        return Err(format!("本次运行最多加载 {registry_limit} 个本地专家；已有配置未修改"));
    }
    // A stable file may retain its old name after a display rename. Reusing
    // that old display name creates a new identity rather than replacing it.
    if previous.is_none() && path.exists() { path = root.join(format!("{safe_name}--{}.md", uuid::Uuid::now_v7())); }
    if previous.is_some() {
        crate::paths::write_private_file(&path, raw.as_bytes())?;
    } else {
        // Publish complete bytes with an exclusive hard-link. Unlike rename,
        // this cannot overwrite an existing file, even across processes.
        let staged = root.join(format!(".new-{}.tmp", uuid::Uuid::now_v7()));
        crate::paths::write_private_file(&staged, raw.as_bytes())?;
        let published = std::fs::hard_link(&staged, &path);
        let _ = std::fs::remove_file(&staged);
        published.map_err(|e| format!("创建专家失败（同名文件可能已存在），已有配置未修改：{e}"))?;
    }
    let fm = parse_frontmatter(&raw);
    let entry = AgentEntry {
        // Fall back to the caller's display name, never the slug: the slug is a
        // filename detail and showing it would surface "dai-ma-zhuan-jia"-style
        // stems (or a hash) in the UI.
        name: fm.name.unwrap_or_else(|| name.trim().to_string()),
        description: fm.description,
        scope: "user".into(),
        path: path.to_string_lossy().into_owned(),
        avatar: fm.avatar,
        model_tags: fm.model_tags.clone(),
        raw,
    };
    trusted.insert(entry.name.clone());
    Ok(entry)
}

/// Delete an agent file by path.
#[tauri::command]
pub fn agents_delete(path: String) -> Result<(), String> {
    let _guard = AGENT_WRITES.lock().map_err(|_| "专家存储锁已损坏")?;
    let safe = resolve_user_agent_path(&path)?;
    let lock = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(safe.parent().unwrap().join(".write.lock")).map_err(|e| e.to_string())?;
    lock.lock_exclusive().map_err(|e| e.to_string())?;
    std::fs::remove_file(&safe).map_err(|e| format!("delete {}: {e}", safe.display()))
}

/// Build a starter agent markdown body from a name/description/system prompt.
/// Exposed as a command so the frontend's "create assistant" form can render a
/// preview before saving. Optional `avatar` (1-20) and `model_tags`
/// (Vec<String>) are written to frontmatter so the UI can render the avatar
/// preset and capability badges.
#[tauri::command]
pub fn agents_template(
    name: String,
    description: String,
    system_prompt: String,
    avatar: Option<u32>,
    model_tags: Option<Vec<String>>,
) -> Result<String, String> {
    if name.trim().is_empty() {
        return Err("助理名称不能为空".into());
    }
    if name.chars().count() > MAX_AGENT_NAME_CHARS {
        return Err(format!("助理名称不能超过 {MAX_AGENT_NAME_CHARS} 个字符"));
    }
    if description.chars().count() > MAX_AGENT_DESCRIPTION_CHARS {
        return Err(format!(
            "助理描述不能超过 {MAX_AGENT_DESCRIPTION_CHARS} 个字符"
        ));
    }
    if system_prompt.len() as u64 > MAX_AGENT_FILE_BYTES {
        return Err("Agent 提示词不能超过 1 MB".into());
    }
    if avatar.is_some_and(|value| !(1..=20).contains(&value)) {
        return Err("头像编号必须在 1 到 20 之间".into());
    }
    if let Some(tags) = model_tags.as_ref() {
        if tags.len() > MAX_AGENT_MODEL_TAGS
            || tags
                .iter()
                .any(|tag| !matches!(tag.as_str(), "default" | "multimodal" | "reasoning"))
        {
            return Err("模型能力标签无效".into());
        }
    }
    // Write the display name verbatim (quoted), not the filename slug: this
    // field is what the UI lists and what Runtime name resolution matches on, so
    // slugging it here silently renamed every non-ASCII assistant and broke the
    // automation prompt lookup.
    let mut fm = format!(
        "---\nname: {}\ndescription: {}\n",
        yaml_scalar(name.trim()),
        yaml_scalar(&description)
    );
    if let Some(a) = avatar {
        fm.push_str(&format!("avatar: {a}\n"));
    }
    if let Some(tags) = model_tags.as_ref().filter(|t| !t.is_empty()) {
        // Inline YAML array form.
        let joined: Vec<String> = tags.iter().map(|t| format!("{t:?}")).collect();
        fm.push_str(&format!("model_tags: [{}]\n", joined.join(", ")));
    }
    fm.push_str("---\n\n");
    fm.push_str(system_prompt.trim());
    fm.push('\n');
    if fm.len() as u64 > MAX_AGENT_FILE_BYTES {
        return Err("Agent 定义不能超过 1 MB".into());
    }
    Ok(fm)
}

/// Longest slug we will write, in bytes. Well under the 255-byte per-component
/// limit of ext4/APFS/NTFS once `.md` and a dedupe suffix are appended.
const MAX_SLUG_BYTES: usize = 120;

/// Characters that are unsafe in a path component on Windows or POSIX.
fn is_unsafe_filename_char(c: char) -> bool {
    matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        || c.is_control()
        || c.is_whitespace()
}

/// Derive a filesystem-safe slug from an agent's display name.
///
/// This deliberately preserves non-ASCII letters (CJK included) instead of
/// stripping them: every filesystem we target stores UTF-8 filenames, and the
/// old `[a-z0-9-]`-only rule reduced a purely Chinese name such as "代码专家"
/// to the empty string, which made saving it impossible. Only genuinely unsafe
/// path characters are folded to `-`.
///
/// Returns an empty string when nothing usable survives (e.g. a name made
/// entirely of punctuation); callers must supply their own fallback rather than
/// writing a file with no stem — see [`slug_for_agent`].
fn sanitize_name(name: &str) -> String {
    let mut slug = String::new();
    let mut pending_dash = false;
    for ch in name.trim().chars() {
        // Fold separators and unsafe characters into a single `-` so
        // "产品经理 （副本）" does not become a run of dashes.
        if is_unsafe_filename_char(ch) || ch == '-' || ch == '.' {
            pending_dash = !slug.is_empty();
            continue;
        }
        let lowered = ch.to_lowercase().next().unwrap_or(ch);
        if slug.len() + lowered.len_utf8() + usize::from(pending_dash) > MAX_SLUG_BYTES {
            break;
        }
        if pending_dash {
            slug.push('-');
            pending_dash = false;
        }
        slug.push(lowered);
    }
    // Never hand back `.`/`..`-like stems, which are not valid filenames.
    slug.trim_matches('-').to_string()
}

/// Short stable hash used to name agents whose display name yields no slug.
fn fallback_slug(name: &str) -> String {
    // FNV-1a: tiny, dependency-free, and stable across runs so re-saving the
    // same name overwrites its own file instead of piling up duplicates.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in name.trim().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("agent-{hash:016x}")
}

/// Filename stem for an agent, guaranteed non-empty for any non-blank name.
fn slug_for_agent(name: &str) -> String {
    let slug = sanitize_name(name);
    if slug.is_empty() {
        fallback_slug(name)
    } else {
        slug
    }
}

/// Escape a display name for a single-line YAML scalar value.
///
/// Quoting is what lets a name containing `:` or `#` survive a round trip, and
/// it must stay symmetric with [`parse_scalar`].
fn yaml_scalar(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace(['\n', '\r'], " ");
    format!("\"{escaped}\"")
}

/// Read a single-line YAML scalar: unwrap one layer of matching quotes and undo
/// the escaping applied by [`yaml_scalar`]. Unquoted legacy values pass through
/// unchanged, so agent files written before quoting still parse.
fn parse_scalar(value: &str) -> String {
    let value = value.trim();
    let quote = match value.chars().next() {
        Some(q @ ('"' | '\'')) if value.len() >= 2 && value.ends_with(q) => q,
        // Unquoted (or unbalanced): take it literally, matching the old parser.
        _ => return value.to_string(),
    };
    let inner = &value[1..value.len() - 1];
    if quote == '\'' {
        // YAML single-quoted style has no backslash escapes.
        return inner.replace("''", "'");
    }
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            // Covers the `\\` and `\"` pairs that yaml_scalar emits.
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editor_merge_preserves_advanced_yaml_across_quotes_crlf_and_delimiter_spaces() {
        let original = "---\r\n\"name\": Old\r\n'description': old\r\nmodel: custom-model\r\ntools: [read_file]\r\navatar: 1\r\nmodel_tags: [reasoning]\r\nfuture:\r\n  nested: [a, b]\r\n---   \r\nold prompt";
        let generated = agents_template("New".into(), "new description".into(), "new prompt".into(), None, None).unwrap();
        let merged = merge_expert_definition(original, &generated).unwrap();
        let before = definition_yaml(original).unwrap();
        let after = definition_yaml(&merged).unwrap();
        for key in ["model", "tools", "future"] { assert_eq!(before[key], after[key]); }
        assert_eq!(after["name"].as_str(), Some("New"));
        assert_eq!(after["description"].as_str(), Some("new description"));
        assert!(!after.contains_key(serde_yaml::Value::String("avatar".into())));
        assert!(!after.contains_key(serde_yaml::Value::String("model_tags".into())));
        assert_eq!(markdown_body(&merged), "new prompt");
    }

    #[test]
    fn editor_merge_retains_alias_values_and_rejects_unreadable_originals() {
        let original = "---\nname: Old\ndescription: &description original\nfuture: { retained: *description }\n---\nold";
        let generated = agents_template("New".into(), "changed".into(), "new".into(), None, None).unwrap();
        let merged = merge_expert_definition(original, &generated).unwrap();
        assert_eq!(definition_yaml(&merged).unwrap()["future"]["retained"].as_str(), Some("original"));
        for invalid in ["no frontmatter", "---\nname: incomplete", "---\nname: A\nname: B\n---\nbody"] {
            assert!(merge_expert_definition(invalid, &generated).is_err());
        }
        assert!(merge_expert_definition(original, "broken template").is_err());
    }


    #[test]
    fn registry_capacity_failure_precedes_any_expert_file_commit() {
        let home = tempfile::tempdir().unwrap();
        let registry = Mutex::new(HashSet::from(["Known".to_string()]));
        let raw = agents_template("New".into(), "test".into(), "unsaved".into(), None, None).unwrap();
        let error = save_agent_with_registry_at(home.path(), "New", raw, None, &registry, 1).unwrap_err();
        assert!(error.contains("已有配置未修改"));
        assert!(scan_dir(home.path(), "user").is_empty());
        assert!(!home.path().join("new.md").exists());
        assert_eq!(registry.lock().unwrap().len(), 1);
        let raw = agents_template("Known".into(), "test".into(), "saved".into(), None, None).unwrap();
        assert!(save_agent_with_registry_at(home.path(), "Known", raw, None, &registry, 1).is_ok());
    }

    #[test]
    fn advanced_yaml_nested_identity_does_not_replace_top_level_fields() {
        let raw = "---\nname: Visible Expert\ndescription: |\n  multi-line description\ncustom_future_field:\n  name: nested-value\n  description: nested-description\n---\nActual prompt";
        let parsed = parse_frontmatter(raw);
        assert_eq!(parsed.name.as_deref(), Some("Visible Expert"));
        assert!(parsed.description.unwrap().contains("multi-line description"));
    }

    #[test]
    fn runtime_binding_rejects_changed_or_rebound_file_identity() {
        let workspace = tempfile::tempdir().unwrap(); let cwd = workspace.path().canonicalize().unwrap();
        let root = cwd.join(".echo-agent/agents"); std::fs::create_dir_all(&root).unwrap();
        let raw = agents_template("controlled-fixture-expert".into(), "test".into(), "snapshot".into(), None, None).unwrap();
        let path = root.join("stable.md"); std::fs::write(&path, &raw).unwrap();
        assert!(require_expert_snapshot(&cwd, "controlled-fixture-expert", path.to_str().unwrap(), &raw).is_ok());
        assert!(require_expert_snapshot(&cwd, "controlled-fixture-expert", path.to_str().unwrap(), "outdated").is_err());
        let other = root.join("other.md"); std::fs::write(&other, raw.replace("controlled-fixture-expert", "other-expert")).unwrap();
        assert!(require_runtime_identity("controlled-fixture-expert", &other, &cwd).is_err());
        std::fs::write(&path, raw.replace("controlled-fixture-expert", "renamed-fixture-expert")).unwrap();
        assert!(require_runtime_identity("controlled-fixture-expert", &path, &cwd).is_err());
        assert!(require_runtime_identity("renamed-fixture-expert", &path, &cwd).is_ok());
    }

    #[test]
    fn expert_create_and_rename_do_not_overwrite_and_reject_stale_updates() {
        let home = tempfile::tempdir().unwrap();
        let raw = agents_template("Alpha".into(), "original".into(), "Keep original".into(), None, None).unwrap();
        let first = save_agent_at(home.path(), "Alpha", raw.clone(), None).unwrap();
        assert!(save_agent_at(home.path(), "Alpha", raw.clone(), None).is_err());
        let beta_raw = agents_template("Beta".into(), "other".into(), "Keep beta".into(), None, None).unwrap();
        let beta = save_agent_at(home.path(), "Beta", beta_raw.clone(), None).unwrap();
        assert!(save_agent_at(home.path(), "Beta", beta_raw, Some((Path::new(&first.path), &raw))).is_err());
        assert_eq!(std::fs::read_to_string(&first.path).unwrap(), raw);
        assert_eq!(std::fs::read_to_string(&beta.path).unwrap(), beta.raw);
        let renamed = agents_template("Renamed".into(), "new".into(), "New prompt".into(), None, None).unwrap();
        assert!(save_agent_at(home.path(), "Renamed", renamed.clone(), Some((Path::new(&first.path), "stale"))).is_err());
        let saved = save_agent_at(home.path(), "Renamed", renamed.clone(), Some((Path::new(&first.path), &raw))).unwrap();
        assert_eq!(saved.path, first.path);
        assert_eq!(std::fs::read_to_string(&saved.path).unwrap(), renamed);
        let reused = save_agent_at(home.path(), "Alpha", raw.clone(), None).unwrap();
        assert_ne!(reused.path, saved.path);
        assert_eq!(std::fs::read_to_string(&saved.path).unwrap(), renamed);
    }

    #[test]
    fn expert_creation_rejects_normalized_filename_collisions() {
        let home = tempfile::tempdir().unwrap();
        let raw = agents_template("A B".into(), "original".into(), "Original".into(), None, None).unwrap();
        save_agent_at(home.path(), "A B", raw.clone(), None).unwrap();
        let conflicting = agents_template("A-B".into(), "new".into(), "New".into(), None, None).unwrap();
        assert!(save_agent_at(home.path(), "A-B", conflicting, None).is_err());
        assert_eq!(std::fs::read_to_string(home.path().join("a-b.md")).unwrap(), raw);
    }

    #[test]
    fn cjk_names_keep_a_usable_slug() {
        // Regression: the old `[a-z0-9-]`-only rule emptied these, so saving a
        // Chinese-named assistant failed with "agent name must not be empty".
        assert_eq!(sanitize_name("代码专家"), "代码专家");
        assert_eq!(sanitize_name("产品经理（副本）"), "产品经理（副本）");
        assert!(!slug_for_agent("代码专家").is_empty());
    }

    #[test]
    fn mixed_and_ascii_names_normalize() {
        assert_eq!(sanitize_name("Code Reviewer"), "code-reviewer");
        assert_eq!(sanitize_name("数据分析 Pro"), "数据分析-pro");
        assert_eq!(sanitize_name("  spaced  out  "), "spaced-out");
    }

    #[test]
    fn unsafe_path_characters_are_folded() {
        assert_eq!(sanitize_name("a/b"), "a-b");
        assert_eq!(sanitize_name("../../etc/passwd"), "etc-passwd");
        assert_eq!(sanitize_name("a:b*c?d\"e<f>g|h"), "a-b-c-d-e-f-g-h");
        assert_eq!(sanitize_name(".."), "");
        assert_eq!(sanitize_name("."), "");
        // A slug can never reintroduce a path separator or traversal.
        for name in ["../x", "..", "a/../b", "C:\\x"] {
            let slug = slug_for_agent(name);
            assert!(!slug.is_empty());
            assert!(!slug.contains('/') && !slug.contains('\\') && slug != ".." && slug != ".");
        }
    }

    #[test]
    fn names_with_no_usable_slug_fall_back_to_a_stable_hash() {
        // Every character here is either unsafe or stripped, so the slug is
        // empty and the hash fallback is what keeps the save working.
        let slug = slug_for_agent("...");
        assert!(slug.starts_with("agent-"), "unexpected slug {slug:?}");
        // Stable across calls so re-saving overwrites rather than duplicating.
        assert_eq!(slug, slug_for_agent("..."));
        assert_ne!(slug, slug_for_agent("///"));
        // `!` is legal in a filename, so it must NOT be forced onto the fallback.
        assert_eq!(slug_for_agent("!!!"), "!!!");
    }

    #[test]
    fn slug_is_length_capped_on_a_char_boundary() {
        let slug = slug_for_agent(&"代".repeat(200));
        assert!(
            slug.len() <= MAX_SLUG_BYTES,
            "slug was {} bytes",
            slug.len()
        );
        // Truncation must not split a multi-byte char (String would panic).
        assert!(slug.chars().all(|c| c == '代'));
    }

    #[test]
    fn template_roundtrips_the_display_name_not_the_slug() {
        let raw = agents_template(
            "代码专家".into(),
            "帮忙审查代码".into(),
            "你是一名代码审查专家。".into(),
            Some(3),
            Some(vec!["default".into()]),
        )
        .expect("template");
        let fm = parse_frontmatter(&raw);
        assert_eq!(fm.name.as_deref(), Some("代码专家"));
        assert_eq!(fm.description.as_deref(), Some("帮忙审查代码"));
        assert_eq!(fm.avatar, Some(3));
        assert_eq!(fm.model_tags, vec!["default".to_string()]);
    }

    #[test]
    fn template_rejects_invalid_or_unbounded_metadata() {
        assert!(agents_template(
            "agent".into(),
            "description".into(),
            "prompt".into(),
            Some(21),
            None,
        )
        .is_err());
        assert!(agents_template(
            "agent".into(),
            "description".into(),
            "prompt".into(),
            None,
            Some(vec!["unknown".into()]),
        )
        .is_err());
        assert!(agents_template(
            "n".repeat(MAX_AGENT_NAME_CHARS + 1),
            "description".into(),
            "prompt".into(),
            None,
            None,
        )
        .is_err());
    }

    #[test]
    fn quoted_scalars_survive_special_characters() {
        // `:` and `#` in a name previously truncated or corrupted the value.
        for name in ["a: b", "say \"hi\"", "back\\slash", "tag#1", "中文: 值"] {
            let line = yaml_scalar(name);
            assert_eq!(parse_scalar(&line), name, "roundtrip failed for {name:?}");
        }
    }

    #[test]
    fn unquoted_legacy_frontmatter_still_parses() {
        let fm =
            parse_frontmatter("---\nname: legacy-agent\ndescription: old style\n---\n\nbody\n");
        assert_eq!(fm.name.as_deref(), Some("legacy-agent"));
        assert_eq!(fm.description.as_deref(), Some("old style"));
    }

    #[test]
    fn oversized_agent_file_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("too-large.md");
        std::fs::write(&path, vec![b'x'; MAX_AGENT_FILE_BYTES as usize + 1]).unwrap();
        assert!(read_agent_file(&path).unwrap_err().contains("不能超过"));
    }

    #[test]
    fn directory_scan_has_a_stable_file_count_limit() {
        let dir = tempfile::tempdir().unwrap();
        for index in 0..(MAX_AGENT_FILES + 5) {
            std::fs::write(
                dir.path().join(format!("agent-{index:04}.md")),
                format!("---\nname: agent-{index:04}\n---\nbody"),
            )
            .unwrap();
        }
        let agents = scan_dir(dir.path(), "test");
        assert_eq!(agents.len(), MAX_AGENT_FILES);
        assert_eq!(agents.first().unwrap().name, "agent-0000");
        assert_eq!(agents.last().unwrap().name, "agent-0255");
    }

    #[cfg(unix)]
    #[test]
    fn directory_scan_does_not_follow_agent_symlinks() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(outside.path(), "---\nname: escaped\n---\nsecret").unwrap();
        symlink(outside.path(), dir.path().join("escaped.md")).unwrap();
        assert!(scan_dir(dir.path(), "test").is_empty());
    }

    #[test]
    fn local_expert_binding_requires_a_backend_listed_exact_name() {
        let name = "security-test-local-expert";
        remember_local_agents(&[AgentEntry {
            name: name.into(),
            description: None,
            scope: "user".into(),
            path: "/managed/agent.md".into(),
            raw: "prompt".into(),
            avatar: None,
            model_tags: Vec::new(),
        }])
        .unwrap();
        assert!(require_listed_local_expert(name, name, None).is_ok());
        assert!(require_listed_local_expert(name, name, Some("/etc/passwd")).is_err());
        assert!(require_listed_local_expert(name, "forged name", None).is_err());
    }
}
