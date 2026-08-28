//! Skill catalog — scanned LIVE from the local WorkBuddy data directories.
//!
//! Unlike the expert catalog (which reads a pre-built manifest), skills are
//! discovered by scanning for `SKILL.md` files at runtime and parsing each
//! file's YAML frontmatter. Two sources are merged:
//!
//!   1. Agent-nested skills: `<agentsRoot>/<plugin>/skills/<name>/SKILL.md`.
//!   2. Built-in skills: `<builtinRoot>/<name>/SKILL.md`.
//!
//! Dedup by skill `name` (frontmatter) — built-ins win and are flagged
//! `featured`. Scanning is wrapped in `spawn_blocking` so the ~550 file walk
//! never blocks the async runtime.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

// ---------- output types ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillCategory {
    pub id: String,
    pub zh: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillItem {
    /// Skill name from frontmatter (falls back to the directory name).
    pub id: String,
    /// Display name (frontmatter `name` may be a human label).
    pub name: String,
    /// `description_zh` if present, else `description` (trimmed).
    pub desc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desc_en: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub when_to_use: Option<String>,
    /// Absolute directory containing the SKILL.md (feed to
    /// `skills_catalog_read_skill` / grok's skill-add).
    pub source_dir: String,
    /// "connector" (from a connector package) | "builtin" (workbuddy built-in).
    pub origin: String,
    /// Owning connector source name (connector origin only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin: Option<String>,
    /// Absolute local icon path (connector skills resolve their connector's
    /// icon); feed to `connectors_icon`. None for built-in skills.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_local: Option<String>,
    /// Derived category id.
    pub cat: String,
    /// Built-in skills are featured (精选).
    #[serde(default)]
    pub featured: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCatalog {
    pub root: String,
    pub builtin_root: String,
    pub categories: Vec<SkillCategory>,
    pub skills: Vec<SkillItem>,
}

// ---------- frontmatter parsing ----------
//
// A lightweight YAML-subset extractor. The skill frontmatter we see in
// practice uses only: `key: value`, `key: "quoted"`, `key: >- / |` block
// scalars, and `key:` + nested indented lines (for `metadata:`). We don't
// pull in a full YAML crate — we only need a handful of scalar fields. A
// handful of skills ship without any frontmatter (they describe themselves
// with a Markdown `# Title` + a loose `description:` line); for those we
// fall back to the body (see parse_skill_file Path B).

/// Extract the raw frontmatter block (text between the opening `---` and the
/// closing `---`). Returns `None` if the file has no valid frontmatter.
fn extract_frontmatter(text: &str) -> Option<&str> {
    let t = text.trim_start();
    if !t.starts_with("---") {
        return None;
    }
    let after_open = t.get(3..)?;
    // Skip the rest of the opening line.
    let nl = after_open.find('\n')?;
    let rest = &after_open[nl + 1..];
    // Find a line that is exactly `---` (allow trailing whitespace).
    let mut pos = 0;
    while pos < rest.len() {
        let nl_pos = match rest[pos..].find('\n') {
            Some(i) => pos + i,
            None => return None,
        };
        let line = rest[pos..nl_pos].trim_end();
        if line == "---" {
            return Some(&rest[..pos]);
        }
        pos = nl_pos + 1;
    }
    None
}

/// Parse a single scalar field from frontmatter text. Handles:
///   - `key: plain value`
///   - `key: "quoted"` / `key: 'quoted'`
///   - `key: >-` / `key: |` / `key: |-` block scalars (following indented lines)
///   - plain values with folded continuation lines (indented follow-ups,
///     YAML's implicit multi-line scalar — joined with spaces)
fn parse_scalar(fm: &str, key: &str) -> Option<String> {
    let needle = format!("{key}:");
    let lines: Vec<&str> = fm.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        // Only match a top-level key (no leading whitespace).
        let trimmed_start = line.trim_start();
        if trimmed_start.len() == line.len() && trimmed_start.starts_with(&needle) {
            let mut val = trimmed_start[needle.len()..].trim().to_string();
            // Block scalar indicator: capture subsequent indented lines.
            if val == "|" || val == "|-" || val == ">" || val == ">-" {
                return Some(collect_block_lines(&lines, i, &val));
            }
            // Strip surrounding quotes (single-line quoted scalar).
            if (val.starts_with('"') && val.ends_with('"') && val.len() >= 2)
                || (val.starts_with('\'') && val.ends_with('\'') && val.len() >= 2)
            {
                val = val[1..val.len() - 1].to_string();
            } else if !val.is_empty() {
                // Plain scalar — fold any immediately-following indented lines
                // (YAML's implicit multi-line plain scalar).
                let mut parts: Vec<String> = vec![val];
                for cont in lines.iter().skip(i + 1) {
                    if cont.trim().is_empty() {
                        break;
                    }
                    // A continuation line must be indented (more than the key).
                    let indent = cont.len() - cont.trim_start().len();
                    if indent == 0 {
                        break;
                    }
                    parts.push(cont.trim().to_string());
                }
                val = parts.join(" ");
            }
            if val.is_empty() {
                return None;
            }
            return Some(val);
        }
    }
    None
}

/// Collect the indented continuation lines of a block scalar (`|` / `|-` /
/// `>` / `>-`) starting at line index `key_idx`. Preserves newlines for `|`
/// variants and joins with spaces for `>` variants.
fn collect_block_lines(lines: &[&str], key_idx: usize, indicator: &str) -> String {
    let mut collected: Vec<String> = Vec::new();
    let mut base_indent: Option<usize> = None;
    for line in lines.iter().skip(key_idx + 1) {
        // A blank line is part of the block.
        if line.trim().is_empty() {
            collected.push(String::new());
            continue;
        }
        // Measure indentation.
        let indent = line.len() - line.trim_start().len();
        match base_indent {
            None => {
                // First content line sets the indent. A less-indented or
                // unindented line ends the block.
                if indent == 0 {
                    break;
                }
                base_indent = Some(indent);
                collected.push(line[indent..].to_string());
            }
            Some(bi) => {
                if indent < bi {
                    // Dedent ends the block.
                    break;
                }
                collected.push(line[bi..].to_string());
            }
        }
    }
    let fold = indicator == ">" || indicator == ">-";
    if fold {
        // Folded: join lines with spaces, blank lines become paragraph breaks.
        let mut out = String::new();
        let mut prev_blank = false;
        for l in collected {
            if l.is_empty() {
                out.push('\n');
                prev_blank = true;
            } else {
                if !out.is_empty() && !prev_blank {
                    out.push(' ');
                }
                out.push_str(&l);
                prev_blank = false;
            }
        }
        out.trim().to_string()
    } else {
        // Literal: preserve newlines, trim trailing whitespace.
        collected.join("\n").trim().to_string()
    }
}

// ---------- category derivation ----------

fn categories() -> Vec<SkillCategory> {
    vec![
        SkillCategory {
            id: "dev".into(),
            zh: "开发工具".into(),
        },
        SkillCategory {
            id: "office".into(),
            zh: "办公协同".into(),
        },
        SkillCategory {
            id: "invest".into(),
            zh: "投资理财".into(),
        },
        SkillCategory {
            id: "data".into(),
            zh: "数据分析".into(),
        },
        SkillCategory {
            id: "content".into(),
            zh: "内容创作".into(),
        },
        SkillCategory {
            id: "eff".into(),
            zh: "效率工具".into(),
        },
        SkillCategory {
            id: "info".into(),
            zh: "信息资讯".into(),
        },
        SkillCategory {
            id: "design".into(),
            zh: "设计创作".into(),
        },
        SkillCategory {
            id: "other".into(),
            zh: "其他".into(),
        },
    ]
}

/// Derive a category from the skill name + description. Keyword-based, since
/// most skills lack an explicit category field.
fn derive_category(name: &str, desc: &str) -> String {
    let hay = format!("{name} {desc}").to_lowercase();
    let rules: &[(&str, &str)] = &[
        ("股票|行情|财报|基金|估值|投资|金融|盘|资金流|选股|k线", "invest"),
        ("word|excel|ppt|powerpoint|文档|表格|幻灯片|office|wps|金山", "office"),
        ("代码|api|github|git|部署|全栈|backend|frontend|react|nextjs|sql|kubernetes|k8s|sentry|debug|refactor", "dev"),
        ("设计|design|figma|poster|slides|ui|canvas|海报|幻灯片|切图|设计稿", "design"),
        ("数据|csv|分析|报表|数据透视|可视化|dashboard", "data"),
        ("翻译|translate|简历|resume|seo|效率|邮件|mail|日程|自动化", "eff"),
        ("新闻|资讯|辟谣|舆情|热搜|热点", "info"),
        ("内容|创作|写作|文案|稿件|视频|字幕|youtube|bilibili|公众号|小红书", "content"),
    ];
    for (pat, cat) in rules {
        for kw in pat.split('|') {
            if hay.contains(kw) {
                return cat.to_string();
            }
        }
    }
    "other".to_string()
}

// ---------- root discovery ----------

/// Candidate connector-marketplace roots — the PRIMARY source of product
/// skills (each connector ships a `skills/SKILL.md`). Mirrors
/// `connectors_catalog::candidate_roots`. `ECHOAGENT_CONNECTORS_DIR` overrides.
fn candidate_connector_roots() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(v) = std::env::var("ECHOAGENT_CONNECTORS_DIR") {
        if !v.is_empty() {
            out.push(PathBuf::from(v));
        }
    }
    if let Some(h) = dirs::home_dir() {
        out.push(h.join(".workbuddy").join("connectors-marketplace"));
    }
    out
}

fn connector_root_valid(root: &Path) -> bool {
    root.join(".codebuddy-connector")
        .join("connectors.json")
        .is_file()
}

/// Candidate built-in skill roots. `ECHOAGENT_BUILTIN_SKILLS_DIR` overrides.
fn candidate_builtin_roots() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(v) = std::env::var("ECHOAGENT_BUILTIN_SKILLS_DIR") {
        if !v.is_empty() {
            out.push(PathBuf::from(v));
        }
    }
    if let Some(h) = dirs::home_dir() {
        out.push(
            h.join(".workbuddy")
                .join("resources")
                .join("builtin-skills"),
        );
    }
    out
}

fn builtin_root_valid(root: &Path) -> bool {
    if !root.is_dir() {
        return false;
    }
    // Must contain at least one SKILL.md one level down.
    if let Ok(rd) = std::fs::read_dir(root) {
        for entry in rd.flatten() {
            if entry.path().join("SKILL.md").is_file() {
                return true;
            }
        }
    }
    false
}

/// Return the default connector-marketplace root (first valid candidate), or "".
#[tauri::command]
pub async fn skills_catalog_default_root() -> Result<String, String> {
    for r in candidate_connector_roots() {
        if connector_root_valid(&r) {
            return Ok(r.to_string_lossy().into_owned());
        }
    }
    Ok(String::new())
}

/// Validate a user-picked connector-marketplace directory (used by the UI picker).
#[tauri::command]
pub async fn skills_catalog_list_roots(root: String) -> Result<Vec<String>, String> {
    let base = PathBuf::from(&root);
    let mut hits = Vec::new();
    if connector_root_valid(&base) {
        hits.push(base.to_string_lossy().into_owned());
    }
    if let Ok(rd) = std::fs::read_dir(&base) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.is_dir() && connector_root_valid(&p) {
                hits.push(p.to_string_lossy().into_owned());
            }
        }
    }
    Ok(hits)
}

// ---------- scanning ----------

struct RawSkill {
    id: String,
    name: String,
    desc: String,
    desc_en: Option<String>,
    version: Option<String>,
    when_to_use: Option<String>,
    source_dir: String,
    origin: String,
    plugin: Option<String>,
    /// Absolute local icon path (connector skills resolve their connector's
    /// icon from the marketplace `icons/` dir).
    icon_local: Option<String>,
}

/// Parse a single SKILL.md into a RawSkill. Falls back gracefully when the
/// file has no YAML frontmatter (some skills describe themselves with a
/// Markdown `# Title` + a loose `description:` line instead): we then derive
/// the id/name from the directory and try to lift a description from the body.
/// Returns None only when the file can't be read at all.
fn parse_skill_file(path: &Path, origin: &str, plugin: Option<&str>) -> Option<RawSkill> {
    let text = std::fs::read_to_string(path).ok()?;
    let dir_name = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("skill")
        .to_string();
    let source_dir = path
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();

    // Path A: real YAML frontmatter.
    if let Some(fm) = extract_frontmatter(&text) {
        let name_field = parse_scalar(fm, "name");
        // Some skills use `name:` as a human display label rather than a slug.
        let id = name_field
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| dir_name.clone());
        // Display name: prefer `name`, fall back to the directory name.
        let name = name_field.unwrap_or_else(|| dir_name.clone());

        let desc_zh = parse_scalar(fm, "description_zh");
        let desc_plain = parse_scalar(fm, "description").unwrap_or_default();
        let desc = if let Some(dz) = desc_zh {
            dz
        } else if !desc_plain.is_empty() {
            desc_plain
        } else {
            String::new()
        };
        let desc_en = parse_scalar(fm, "description_en");
        let version = parse_scalar(fm, "version");
        let when_to_use =
            parse_scalar(fm, "when_to_use").or_else(|| parse_scalar(fm, "when-to-use"));

        return Some(RawSkill {
            id,
            name,
            desc,
            desc_en,
            version,
            when_to_use,
            source_dir,
            origin: origin.to_string(),
            plugin: plugin.map(str::to_string),
            icon_local: None,
        });
    }

    // Path B: no frontmatter — salvage what we can from the body.
    // Name: a leading `# Title` line, else the directory name.
    let name = first_heading(&text).unwrap_or_else(|| dir_name.clone());
    let id = dir_name.clone();
    // Description: a loose `description:` line in the body, else the first
    // non-empty, non-heading paragraph.
    let desc = loose_field(&text, "description")
        .or_else(|| first_paragraph(&text))
        .unwrap_or_default();

    Some(RawSkill {
        id,
        name,
        desc,
        desc_en: None,
        version: loose_field(&text, "version"),
        when_to_use: loose_field(&text, "when_to_use"),
        source_dir,
        origin: origin.to_string(),
        plugin: plugin.map(str::to_string),
        icon_local: None,
    })
}

/// First Markdown heading (`# Foo`) text, trimmed of a leading `Skill:` label.
fn first_heading(text: &str) -> Option<String> {
    for line in text.lines() {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("# ") {
            let h = rest.trim();
            if !h.is_empty() {
                // Drop a "Skill:" / "# Skill:" prefix if present.
                let cleaned = h
                    .strip_prefix("Skill:")
                    .or_else(|| h.strip_prefix("skill:"))
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(h)
                    .to_string();
                return Some(cleaned);
            }
        }
        // Stop once we hit real content that isn't a heading.
        if !t.is_empty() && !t.starts_with('#') {
            break;
        }
    }
    None
}

/// First non-empty paragraph in the body (skipping headings). Used as a
/// description fallback for frontmatter-less skills.
fn first_paragraph(text: &str) -> Option<String> {
    let mut started = false;
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() {
            if started {
                continue;
            }
            continue;
        }
        if t.starts_with('#') {
            started = true;
            continue;
        }
        // Skip raw `key: value` lines and blockquotes/lists.
        if is_loose_field_line(t) || t.starts_with('>') || t.starts_with('-') || t.starts_with('|')
        {
            started = true;
            continue;
        }
        return Some(t.to_string());
    }
    None
}

/// A loose `key: value` line anywhere in the body (not frontmatter), e.g. an
/// unguarded `description: ...`. Returns the trimmed value.
fn loose_field(text: &str, key: &str) -> Option<String> {
    let needle = format!("{key}:");
    for line in text.lines() {
        let t = line.trim_start();
        if t.starts_with(&needle) {
            let v = t[needle.len()..].trim().to_string();
            if !v.is_empty() {
                return Some(v);
            }
        }
    }
    None
}

fn is_loose_field_line(line: &str) -> bool {
    // A `word: ...` line (single colon near the start, no spaces in the key).
    let Some(colon) = line.find(':') else {
        return false;
    };
    if colon == 0 || colon > 32 {
        return false;
    }
    let key = &line[..colon];
    key.chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
}

/// Walk a connector marketplace root and collect every connector's bundled
/// skill: `<root>/connectors/<source>/skills/SKILL.md`. Each connector has at
/// most one top-level SKILL.md (some also ship `references/*/SKILL.md`
/// sub-docs, which we skip — they're reference material, not standalone skills).
/// The connector `source` is carried as `plugin` so the UI can link back.
fn scan_connector_skills(root: &Path) -> Vec<RawSkill> {
    let mut out = Vec::new();
    let connectors_dir = root.join("connectors");
    let rd = match std::fs::read_dir(&connectors_dir) {
        Ok(r) => r,
        Err(_) => return out,
    };
    for entry in rd.flatten() {
        let conn_path = entry.path();
        if !conn_path.is_dir() {
            continue;
        }
        let source = entry.file_name().to_string_lossy().into_owned();
        // Top-level skill: connectors/<source>/skills/SKILL.md
        let skill_md = conn_path.join("skills").join("SKILL.md");
        if skill_md.is_file() {
            if let Some(mut rs) = parse_skill_file(&skill_md, "connector", Some(&source)) {
                // Resolve the connector icon so the card can show it.
                rs.icon_local = find_connector_icon(root, &source);
                out.push(rs);
            }
        }
    }
    out
}

/// Resolve the on-disk icon for a connector source (`icons/<source>.svg|.png`).
fn find_connector_icon(root: &Path, source: &str) -> Option<String> {
    let icons = root.join("icons");
    for ext in ["svg", "png"] {
        let p = icons.join(format!("{source}.{ext}"));
        if p.is_file() {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    None
}

/// Walk `<root>/<name>/SKILL.md` for the built-in skills.
fn scan_builtin_skills(root: &Path) -> Vec<RawSkill> {
    let mut out = Vec::new();
    let rd = match std::fs::read_dir(root) {
        Ok(r) => r,
        Err(_) => return out,
    };
    for entry in rd.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let skill_md = p.join("SKILL.md");
        if skill_md.is_file() {
            if let Some(rs) = parse_skill_file(&skill_md, "builtin", None) {
                out.push(rs);
            }
        }
    }
    out
}

/// Load and merge both sources, dedup by skill id (built-ins win + featured).
#[tauri::command]
pub async fn skills_catalog_load(
    root: Option<String>,
    builtin_root: Option<String>,
) -> Result<SkillCatalog, String> {
    // Resolve the connector-marketplace root (primary skill source).
    let conn_root = match root {
        Some(r) if !r.is_empty() => PathBuf::from(r),
        _ => candidate_connector_roots()
            .into_iter()
            .find(|r| connector_root_valid(r))
            .unwrap_or_default(),
    };
    // Resolve the built-in root.
    let builtin_root = match builtin_root {
        Some(r) if !r.is_empty() => PathBuf::from(r),
        _ => candidate_builtin_roots()
            .into_iter()
            .find(|r| builtin_root_valid(r))
            .unwrap_or_default(),
    };

    let conn_root_clone = conn_root.clone();
    let builtin_root_clone = builtin_root.clone();
    // Filesystem walks are blocking — run off the async runtime.
    let (conn_skills, builtin_skills) = tokio::task::spawn_blocking(move || {
        let a = if !conn_root_clone.as_os_str().is_empty() {
            scan_connector_skills(&conn_root_clone)
        } else {
            Vec::new()
        };
        let b = if !builtin_root_clone.as_os_str().is_empty() {
            scan_builtin_skills(&builtin_root_clone)
        } else {
            Vec::new()
        };
        (a, b)
    })
    .await
    .map_err(|e| format!("技能扫描任务失败：{e}"))?;

    // Merge: dedup by id, built-ins win and are flagged featured.
    let mut by_id: HashMap<String, RawSkill> = HashMap::new();
    let mut featured_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for rs in conn_skills {
        by_id.entry(rs.id.clone()).or_insert(rs);
    }
    for rs in builtin_skills {
        featured_ids.insert(rs.id.clone());
        by_id.insert(rs.id.clone(), rs);
    }

    let mut skills: Vec<SkillItem> = by_id
        .into_values()
        .map(|rs| {
            let featured = featured_ids.contains(&rs.id);
            let cat = derive_category(&rs.name, &rs.desc);
            SkillItem {
                id: rs.id,
                name: rs.name,
                desc: rs.desc,
                desc_en: rs.desc_en,
                version: rs.version,
                when_to_use: rs.when_to_use,
                source_dir: rs.source_dir,
                origin: rs.origin,
                plugin: rs.plugin,
                icon_local: rs.icon_local,
                cat,
                featured,
            }
        })
        .collect();
    // Stable ordering: featured first, then alphabetical by name.
    skills.sort_by(|a, b| match (a.featured, b.featured) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });

    Ok(SkillCatalog {
        root: conn_root.to_string_lossy().into_owned(),
        builtin_root: builtin_root.to_string_lossy().into_owned(),
        categories: categories(),
        skills,
    })
}

// ---------- skill file reading ----------

/// Read the full SKILL.md text for a directory (the file is `SKILL.md` under
/// `dir`). Returns the raw content so the frontend can strip frontmatter
/// before installing.
#[tauri::command]
pub async fn skills_catalog_read_skill(dir: String) -> Result<String, String> {
    let p = PathBuf::from(&dir).join("SKILL.md");
    if !p.is_file() {
        return Err(format!("未找到 SKILL.md：{dir}"));
    }
    std::fs::read_to_string(&p).map_err(|e| format!("读取 SKILL.md 失败：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_scalar() {
        let fm = "name: my-skill\ndescription: A plain description here.\nversion: 1.0.0\n";
        assert_eq!(parse_scalar(fm, "name").as_deref(), Some("my-skill"));
        assert_eq!(
            parse_scalar(fm, "description").as_deref(),
            Some("A plain description here.")
        );
        assert_eq!(parse_scalar(fm, "version").as_deref(), Some("1.0.0"));
    }

    #[test]
    fn parses_quoted_scalar() {
        let fm = "name: my-skill\ndescription_zh: \"自然语言查询金融数据\"\n";
        assert_eq!(
            parse_scalar(fm, "description_zh").as_deref(),
            Some("自然语言查询金融数据")
        );
    }

    #[test]
    fn parses_block_literal_scalar() {
        // `|-` keeps newlines, trims trailing.
        let fm = "name: westock\ndescription: |-\n  Line one.\n  Line two.\nversion: 1.0.0\n";
        assert_eq!(
            parse_scalar(fm, "description").as_deref(),
            Some("Line one.\nLine two.")
        );
    }

    #[test]
    fn parses_block_folded_scalar() {
        // `>-` folds lines into spaces.
        let fm = "name: neo\ndescription: >-\n  Natural language\n  financial search.\n";
        assert_eq!(
            parse_scalar(fm, "description").as_deref(),
            Some("Natural language financial search.")
        );
    }

    #[test]
    fn folds_plain_multiline_scalar() {
        // A plain value with indented continuation lines (YAML implicit
        // multiline) should be folded with spaces.
        let fm = "name: mse\ndescription: Multi search engine. No API\n  keys required.\nversion: 2.1.3\n";
        assert_eq!(
            parse_scalar(fm, "description").as_deref(),
            Some("Multi search engine. No API keys required.")
        );
    }

    #[test]
    fn returns_none_for_missing_field() {
        let fm = "name: only-name\n";
        assert_eq!(parse_scalar(fm, "description"), None);
    }

    #[test]
    fn ignores_indented_keys() {
        // A nested key under `metadata:` must not match a top-level lookup.
        let fm = "name: x\nmetadata:\n  category: nested\n";
        assert_eq!(parse_scalar(fm, "category"), None);
        assert_eq!(parse_scalar(fm, "name").as_deref(), Some("x"));
    }

    #[test]
    fn extract_frontmatter_strips_markers() {
        let text = "---\nname: x\ndescription: y\n---\n\n# Body\n";
        assert_eq!(extract_frontmatter(text), Some("name: x\ndescription: y\n"));
    }

    #[test]
    fn extract_frontmatter_none_without_markers() {
        assert_eq!(extract_frontmatter("# just body\n"), None);
    }

    #[test]
    fn derive_category_matches_keywords() {
        assert_eq!(derive_category("westock", "查询股票行情"), "invest");
        assert_eq!(derive_category("excel", "Excel 文件处理"), "office");
        assert_eq!(derive_category("fullstack-dev", "REST API backend"), "dev");
        assert_eq!(derive_category("random", "未知领域"), "other");
    }

    // ---- integration tests against the real local data dirs ----
    // These call the actual command functions end-to-end. They are skipped
    // automatically when the connector marketplace isn't present.

    fn marketplace_available() -> bool {
        if let Some(home) = dirs::home_dir() {
            return home
                .join(".workbuddy")
                .join("connectors-marketplace")
                .join(".codebuddy-connector")
                .join("connectors.json")
                .is_file();
        }
        false
    }

    #[tokio::test]
    async fn load_returns_real_skills_from_marketplace() {
        if !marketplace_available() {
            eprintln!("[skip] connector marketplace not present on this machine");
            return;
        }
        let catalog = skills_catalog_load(None, None)
            .await
            .expect("load should succeed");
        // The marketplace ships dozens of connector skills.
        assert!(
            catalog.skills.len() > 10,
            "expected many skills, got {}",
            catalog.skills.len()
        );
        // Every skill must have a non-empty id and source_dir.
        for s in &catalog.skills {
            assert!(!s.id.is_empty(), "skill with empty id: {:?}", s);
            assert!(
                !s.source_dir.is_empty(),
                "skill {} has empty source_dir",
                s.id
            );
        }
        // Connector skills should carry their icon path.
        assert!(
            catalog.skills.iter().any(|s| s.icon_local.is_some()),
            "expected at least one connector skill with an icon"
        );
        // Built-in skills should be flagged featured.
        assert!(
            catalog.skills.iter().any(|s| s.featured),
            "expected at least one featured (builtin) skill"
        );
        // Categories must be non-empty (the fixed catalogue).
        assert!(!catalog.categories.is_empty());
        eprintln!(
            "[ok] skills_catalog_load: {} skills, {} featured, {} with icon, root={}",
            catalog.skills.len(),
            catalog.skills.iter().filter(|s| s.featured).count(),
            catalog
                .skills
                .iter()
                .filter(|s| s.icon_local.is_some())
                .count(),
            catalog.root
        );
    }

    #[tokio::test]
    async fn default_root_finds_marketplace() {
        let root = skills_catalog_default_root()
            .await
            .expect("default_root should not error");
        if !marketplace_available() {
            eprintln!("[skip] marketplace not present (root='{}')", root);
            return;
        }
        assert!(!root.is_empty(), "expected a non-empty default root");
        eprintln!("[ok] skills_catalog_default_root: {}", root);
    }
}
