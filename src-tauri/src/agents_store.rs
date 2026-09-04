//! Experts / Assistants — read & write EchoAgent's agent definition files.
//!
//! EchoAgent discovers "agents" (subagent definitions — see
//! `xai-grok-agent/src/discovery.rs`) by scanning:
//!   - project: `<cwd>/.echo-agent/agents/*.md` and `<cwd>/.claude/agents/*.md`
//!     (walking up to the git worktree root)
//!   - user: `~/.echo-agent/agents/*.md`
//!
//! Each file is markdown with YAML frontmatter (the `AgentDefinition` fields
//! from `xai-grok-agent/src/config.rs:714`) plus a body used as the system
//! prompt. EchoAgent does NOT expose an `echo.agent/agents/*` ACP method, so we read and
//! write these files directly — there's no in-memory state to race with
//! (EchoAgent's file watcher picks up changes on its own).
//!
//! EchoAgent cannot switch the active session's agent (ACP has no such call),
//! but the user can launch a new session guided by an agent's prompt, or
//! spawn the agent via EchoAgent's `spawn_subagent` tool from within a chat.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

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
    let candidate = PathBuf::from(path)
        .canonicalize()
        .map_err(|e| format!("resolve agent path: {e}"))?;
    if candidate.parent() != Some(root.as_path())
        || candidate.extension().and_then(|value| value.to_str()) != Some("md")
    {
        return Err("拒绝访问用户 Agent 目录之外的路径".into());
    }
    Ok(candidate)
}

/// Public accessor for the user-scope agents directory (used by experts.rs
/// to link team member agents for EchoAgent discovery).
pub fn user_agents_dir_pub() -> PathBuf {
    user_agents_dir()
}

/// Project-level agents dir for a cwd: `<cwd>/.echo-agent/agents/`. (We don't walk
/// up to the git root to keep the scan cheap; users can put agents in
/// `~/.echo-agent/agents/` for cross-project access.)
fn project_agents_dir(cwd: &str) -> PathBuf {
    PathBuf::from(cwd).join(".echo-agent").join("agents")
}

/// Scan one directory for `*.md` agent files. Best-effort: unreadable entries
/// are skipped.
fn scan_dir(dir: &Path, scope: &str) -> Vec<AgentEntry> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_md = path.extension().and_then(|e| e.to_str()) == Some("md");
        if !is_md {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&path) else {
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
    fm
}

/// List all agent definitions visible to EchoAgent. Combines user-scope and
/// project-scope (for the given cwd). User entries come first, then project.
#[tauri::command]
pub fn agents_list(cwd: Option<String>) -> Vec<AgentEntry> {
    let mut out = scan_dir(&user_agents_dir(), "user");
    if let Some(cwd) = cwd {
        out.extend(scan_dir(&project_agents_dir(&cwd), "project"));
    }
    // De-dup by name (user scope wins, matching EchoAgent's scope precedence).
    let mut seen = std::collections::HashSet::new();
    out.retain(|a| seen.insert(a.name.clone()));
    out
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

/// Resolve a selected automation expert to its real prompt body. The lookup
/// follows the same user-before-project precedence as the editor.
pub fn resolve_agent_prompt(name: &str, cwd: Option<String>) -> Option<String> {
    agents_list(cwd)
        .into_iter()
        .find(|agent| agent.name == name)
        .map(|agent| markdown_body(&agent.raw))
        .filter(|body| !body.is_empty())
}

/// Fetch a single agent file's full contents.
#[tauri::command]
pub fn agents_get(path: String) -> Result<String, String> {
    let safe = resolve_user_agent_path(&path)?;
    std::fs::read_to_string(&safe).map_err(|e| format!("read {}: {e}", safe.display()))
}

/// Save an agent file (create or overwrite). Writes to the user-scope
/// directory (`~/.echo-agent/agents/<name>.md`) so it's available across projects.
/// The caller supplies the full markdown body (frontmatter + prompt).
#[tauri::command]
pub fn agents_save(name: String, raw: String) -> Result<AgentEntry, String> {
    // Only a blank name is rejected. The slug is derived separately and always
    // resolves to something writable, so a valid display name in any script
    // (e.g. "代码专家") can be saved.
    if name.trim().is_empty() {
        return Err("助理名称不能为空".into());
    }
    let safe_name = slug_for_agent(&name);
    if raw.len() > 1024 * 1024 {
        return Err("Agent 定义不能超过 1 MB".into());
    }
    let dir = user_agents_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("create agents dir: {e}"))?;
    let path = dir.join(format!("{safe_name}.md"));
    std::fs::write(&path, &raw).map_err(|e| format!("write agent: {e}"))?;
    crate::paths::harden_private_file(&path)?;
    let fm = parse_frontmatter(&raw);
    Ok(AgentEntry {
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
    })
}

/// Delete an agent file by path.
#[tauri::command]
pub fn agents_delete(path: String) -> Result<(), String> {
    let safe = resolve_user_agent_path(&path)?;
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
    // Write the display name verbatim (quoted), not the filename slug: this
    // field is what the UI lists and what `resolve_agent_prompt` matches on, so
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
        assert!(slug.len() <= MAX_SLUG_BYTES, "slug was {} bytes", slug.len());
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
    fn quoted_scalars_survive_special_characters() {
        // `:` and `#` in a name previously truncated or corrupted the value.
        for name in ["a: b", "say \"hi\"", "back\\slash", "tag#1", "中文: 值"] {
            let line = yaml_scalar(name);
            assert_eq!(parse_scalar(&line), name, "roundtrip failed for {name:?}");
        }
    }

    #[test]
    fn unquoted_legacy_frontmatter_still_parses() {
        let fm = parse_frontmatter("---\nname: legacy-agent\ndescription: old style\n---\n\nbody\n");
        assert_eq!(fm.name.as_deref(), Some("legacy-agent"));
        assert_eq!(fm.description.as_deref(), Some("old style"));
    }
}
