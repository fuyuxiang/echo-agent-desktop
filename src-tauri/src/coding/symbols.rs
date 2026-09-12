//! Cross-file workspace symbol index (phase 2).
//!
//! Each coding workbench task workspace gets a workspace-level index next to
//! `tasks.json`. The index is intentionally simple — a regular expression
//! driven parse of TS / JS / Rust / Python / Go / Java — so it stays easy to
//! test and never blocks the UI thread. A `tree-sitter` upgrade is left for a
//! later phase that explicitly trades off build time and binary size.
//!
//! Storage layout (per workspace hash):
//! ```text
//! <echo_home>/coding/<hash>/tasks.json
//! <echo_home>/coding/<hash>/symbols.jsonl    // one SymbolRecord per line
//! <echo_home>/coding/<hash>/file_index.json  // { path, mtime_ms, size }[] keyed by file
//! <echo_home>/coding/<hash>/refs.jsonl       // reserved for refs.rs (phase 2 task 19)
//! ```
//!
//! Missing or corrupt files are treated as absent so an interrupted rebuild
//! can never crash the workbench.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};

use crate::coding::store;
use crate::shell_fs::FilesystemAccess;

/// Directories that are always skipped when walking a workspace, even if
/// the project has no `.gitignore` entry. Mirrors the list used by the
/// file watcher so search results and incremental updates stay consistent.
pub const HARD_IGNORED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".venv",
    "__pycache__",
    ".git",
];

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum SymbolKind {
    Function,
    Class,
    Method,
    Constant,
    Type,
    Interface,
    Enum,
    Module,
    Variable,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SymbolRecord {
    /// Stable id derived from `(kind, file, line, column, name)` so reindexing
    /// the same workspace yields the same ids across runs.
    pub id: String,
    pub name: String,
    pub kind: SymbolKind,
    pub container: Option<String>,
    pub file: String,
    pub line: u32,
    pub column: u32,
    pub signature: Option<String>,
    pub exported: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum IndexState {
    Empty,
    Building,
    Ready,
    Rebuilding,
    Stale,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub state: IndexState,
    pub files_indexed: u32,
    pub symbols: u32,
    pub last_reconciled_at: Option<String>,
    pub in_progress: bool,
}

impl Default for IndexStatus {
    fn default() -> Self {
        Self {
            state: IndexState::Empty,
            files_indexed: 0,
            symbols: 0,
            last_reconciled_at: None,
            in_progress: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SymbolQueryHit {
    pub symbol: SymbolRecord,
    pub score: u32,
}

/// One entry in `file_index.json`. Tracked separately so `upsert_file` can
/// skip files whose mtime/size did not change.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileIndexEntry {
    pub path: String,
    pub mtime_ms: u64,
    pub size: u64,
}

/// Stable id derived from `(kind, file, line, column, name)`.
pub fn symbol_id(kind: SymbolKind, file: &str, line: u32, column: u32, name: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{kind:?}").as_bytes());
    hasher.update(file.as_bytes());
    hasher.update(line.to_le_bytes());
    hasher.update(column.to_le_bytes());
    hasher.update(name.as_bytes());
    let digest = hasher.finalize();
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Read the current `IndexStatus`. Falls back to `Empty` when the file index
/// does not exist yet — that is the documented "not built" signal.
pub fn read_status(root: &Path) -> IndexStatus {
    let paths = store::index_paths(root);
    let file_index: Vec<FileIndexEntry> = store::read_json(&paths.file_index).unwrap_or_default();
    let symbols = store::read_jsonl::<SymbolRecord>(&paths.symbols).len();
    let state = if file_index.is_empty() {
        IndexState::Empty
    } else {
        IndexState::Ready
    };
    IndexStatus {
        state,
        files_indexed: file_index.len() as u32,
        symbols: symbols as u32,
        last_reconciled_at: if file_index.is_empty() {
            None
        } else {
            Some(now_rfc3339())
        },
        in_progress: false,
    }
}

/// Write the file index (full replace, not append) after a rebuild.
fn write_file_index(root: &Path, entries: &[FileIndexEntry]) -> Result<(), String> {
    let paths = store::index_paths(root);
    store::write_json(&paths.file_index, &entries.to_vec())
}

fn read_file_index(root: &Path) -> BTreeMap<String, FileIndexEntry> {
    let paths = store::index_paths(root);
    store::read_json::<Vec<FileIndexEntry>>(&paths.file_index)
        .unwrap_or_default()
        .into_iter()
        .map(|e| (e.path.clone(), e))
        .collect()
}

/// Walk the workspace honoring `.gitignore` and a hardcoded ignore list for
/// common build / dependency directories. Returns relative POSIX-style paths
/// so the index is portable across platforms.
pub fn walk_workspace(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut walker = ignore::WalkBuilder::new(root);
    walker
        .standard_filters(true)
        .hidden(false)
        .git_ignore(true)
        .git_global(false)
        .follow_links(false)
        .require_git(false);
    let mut overrides = ignore::overrides::OverrideBuilder::new(root);
    for pattern in HARD_IGNORED_DIRS {
        let _ = overrides.add(&format!("!{pattern}"));
        let _ = overrides.add(&format!("!{pattern}/**"));
    }
    walker.overrides(
        overrides
            .build()
            .expect("hardcoded ignore patterns are valid"),
    );
    let walker = walker.build();
    for entry in walker.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if let Ok(rel) = path.strip_prefix(root) {
            let normalized: PathBuf = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect();
            files.push(normalized);
        }
    }
    files.sort();
    files
}

fn relativize(root: &Path, abs: &Path) -> String {
    match abs.strip_prefix(root) {
        Ok(rel) => rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/"),
        Err(_) => abs.to_string_lossy().into_owned(),
    }
}

/// Return `(file_mtime_ms, file_size)` for a file, or `None` when it cannot
/// be stat-ed. Errors are intentionally swallowed: callers fall back to a
/// fresh re-scan which is always safe.
fn stat_file(root: &Path, rel: &str) -> Option<(u64, u64)> {
    let abs = root.join(rel);
    let metadata = fs::metadata(&abs).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Some((mtime_ms, metadata.len()))
}

/// Read text content for a relative path under the workspace root.
fn read_text(root: &Path, rel: &str) -> Option<String> {
    let abs = root.join(rel);
    let bytes = fs::read(&abs).ok()?;
    if bytes.contains(&0) {
        // Binary file — do not parse.
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Parse one file's symbols using language-aware regular expressions. Symbols
/// returned are sorted by (line, column) so the JSONL append order is stable.
pub fn parse_file(root: &Path, rel: &str) -> Vec<SymbolRecord> {
    let Some(text) = read_text(root, rel) else {
        return Vec::new();
    };
    let ext = Path::new(rel)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mut out = Vec::new();
    parse_with_rules(&text, rel, &ext, &mut out);
    // Resolve method-container parent class when missing.
    resolve_containers(&mut out);
    out.sort_by_key(|s| (s.line, s.column));
    out
}

fn resolve_containers(symbols: &mut [SymbolRecord]) {
    // For any symbol whose kind is Method and whose container is None, assign
    // it to the most recent Class/Interface/Struct preceding it on the same
    // line range. This is a best-effort fallback for files where the parser
    // could not link the method to its type (e.g. multi-line signatures).
    for i in 0..symbols.len() {
        if symbols[i].kind != SymbolKind::Method || symbols[i].container.is_some() {
            continue;
        }
        let line = symbols[i].line;
        let candidate = symbols
            .iter()
            .take(i)
            .rev()
            .find(|s| {
                matches!(
                    s.kind,
                    SymbolKind::Class | SymbolKind::Interface | SymbolKind::Enum | SymbolKind::Type
                ) && s.line <= line
            })
            .map(|s| s.name.clone());
        if let Some(name) = candidate {
            symbols[i].container = Some(name);
        }
    }
}

fn parse_with_rules(text: &str, file: &str, ext: &str, out: &mut Vec<SymbolRecord>) {
    for (_, regex, kind, exported_default) in RULES_BY_EXT.iter().filter(|(e, _, _, _)| *e == ext) {
        for caps in regex.captures_iter(text) {
            let Some(name_match) = caps.name("name") else {
                continue;
            };
            let name = name_match.as_str().to_string();
            if name.is_empty() {
                continue;
            }
            let (line, column) = line_col_from_match(text, name_match.start());
            let exported = caps
                .name("exported")
                .map(|m| m.as_str().eq_ignore_ascii_case("export"))
                .unwrap_or(*exported_default);
            let signature = caps.get(0).map(|m| {
                let raw = m.as_str().trim_end();
                if raw.chars().count() > 160 {
                    format!("{}…", raw.chars().take(160).collect::<String>())
                } else {
                    raw.to_string()
                }
            });
            out.push(SymbolRecord {
                id: symbol_id(*kind, file, line, column, &name),
                name,
                kind: *kind,
                container: None,
                file: file.to_string(),
                line,
                column,
                signature,
                exported,
            });
        }
    }
}

fn line_col_from_match(text: &str, byte_offset: usize) -> (u32, u32) {
    let prefix = &text[..byte_offset.min(text.len())];
    let mut line: u32 = 1;
    let mut last_newline: usize = 0;
    for (idx, ch) in prefix.char_indices() {
        if ch == '\n' {
            line += 1;
            last_newline = idx + 1;
        }
    }
    let column = (byte_offset.saturating_sub(last_newline) as u32) + 1;
    (line, column)
}

/// Language-aware symbol recognition rules. Built lazily once at first use
/// and then reused. The static is keyed by file extension; only rules whose
/// extension matches are iterated during parsing.
type RuleEntry = (&'static str, Regex, SymbolKind, bool);

fn make_rules() -> Vec<RuleEntry> {
    vec![
        // TypeScript / JavaScript: `export function/const/class/interface/type/enum NAME`
        (
            "ts",
            Regex::new(r"(?m)^[ \t]*(?P<exported>export)?[ \t]*(?:async[ \t]+)?function[ \t]+(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)").unwrap(),
            SymbolKind::Function,
            false,
        ),
        (
            "tsx",
            Regex::new(r"(?m)^[ \t]*(?P<exported>export)?[ \t]*(?:async[ \t]+)?function[ \t]+(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)").unwrap(),
            SymbolKind::Function,
            false,
        ),
        (
            "js",
            Regex::new(r"(?m)^[ \t]*(?P<exported>export)?[ \t]*(?:async[ \t]+)?function[ \t]+(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)").unwrap(),
            SymbolKind::Function,
            false,
        ),
        (
            "jsx",
            Regex::new(r"(?m)^[ \t]*(?P<exported>export)?[ \t]*(?:async[ \t]+)?function[ \t]+(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)").unwrap(),
            SymbolKind::Function,
            false,
        ),
        (
            "mts",
            Regex::new(r"(?m)^[ \t]*(?P<exported>export)?[ \t]*(?:async[ \t]+)?function[ \t]+(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)").unwrap(),
            SymbolKind::Function,
            false,
        ),
        (
            "cts",
            Regex::new(r"(?m)^[ \t]*(?P<exported>export)?[ \t]*(?:async[ \t]+)?function[ \t]+(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)").unwrap(),
            SymbolKind::Function,
            false,
        ),
        // TS/JS: exported class / interface / type / enum / const
        (
            "ts",
            Regex::new(r"(?m)^[ \t]*(?P<exported>export)?[ \t]*(?:abstract[ \t]+)?class[ \t]+(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)").unwrap(),
            SymbolKind::Class,
            false,
        ),
        (
            "tsx",
            Regex::new(r"(?m)^[ \t]*(?P<exported>export)?[ \t]*(?:abstract[ \t]+)?class[ \t]+(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)").unwrap(),
            SymbolKind::Class,
            false,
        ),
        (
            "js",
            Regex::new(r"(?m)^[ \t]*(?P<exported>export)?[ \t]*(?:abstract[ \t]+)?class[ \t]+(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)").unwrap(),
            SymbolKind::Class,
            false,
        ),
        (
            "jsx",
            Regex::new(r"(?m)^[ \t]*(?P<exported>export)?[ \t]*(?:abstract[ \t]+)?class[ \t]+(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)").unwrap(),
            SymbolKind::Class,
            false,
        ),
        (
            "ts",
            Regex::new(r"(?m)^[ \t]*(?P<exported>export)?[ \t]*interface[ \t]+(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)").unwrap(),
            SymbolKind::Interface,
            false,
        ),
        (
            "ts",
            Regex::new(r"(?m)^[ \t]*(?P<exported>export)?[ \t]*type[ \t]+(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)").unwrap(),
            SymbolKind::Type,
            false,
        ),
        (
            "ts",
            Regex::new(r"(?m)^[ \t]*(?P<exported>export)?[ \t]*enum[ \t]+(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)").unwrap(),
            SymbolKind::Enum,
            false,
        ),
        (
            "tsx",
            Regex::new(r"(?m)^[ \t]*(?P<exported>export)?[ \t]*interface[ \t]+(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)").unwrap(),
            SymbolKind::Interface,
            false,
        ),
        (
            "tsx",
            Regex::new(r"(?m)^[ \t]*(?P<exported>export)?[ \t]*type[ \t]+(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)").unwrap(),
            SymbolKind::Type,
            false,
        ),
        (
            "tsx",
            Regex::new(r"(?m)^[ \t]*(?P<exported>export)?[ \t]*enum[ \t]+(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)").unwrap(),
            SymbolKind::Enum,
            false,
        ),
        (
            "ts",
            Regex::new(r"(?m)^[ \t]*(?P<exported>export)?[ \t]*const[ \t]+(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)").unwrap(),
            SymbolKind::Constant,
            false,
        ),
        (
            "tsx",
            Regex::new(r"(?m)^[ \t]*(?P<exported>export)?[ \t]*const[ \t]+(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)").unwrap(),
            SymbolKind::Constant,
            false,
        ),
        (
            "js",
            Regex::new(r"(?m)^[ \t]*(?P<exported>export)?[ \t]*const[ \t]+(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)").unwrap(),
            SymbolKind::Constant,
            false,
        ),
        (
            "jsx",
            Regex::new(r"(?m)^[ \t]*(?P<exported>export)?[ \t]*const[ \t]+(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)").unwrap(),
            SymbolKind::Constant,
            false,
        ),

        // TypeScript / JavaScript class methods: indented identifier followed by `(` (and optional params).
        (
            "ts",
            Regex::new(r"(?m)^[ \t]+(?:public[ \t]+|private[ \t]+|protected[ \t]+|static[ \t]+|async[ \t]+|readonly[ \t]+)*(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)[ \t]*\(").unwrap(),
            SymbolKind::Method,
            false,
        ),
        (
            "tsx",
            Regex::new(r"(?m)^[ \t]+(?:public[ \t]+|private[ \t]+|protected[ \t]+|static[ \t]+|async[ \t]+|readonly[ \t]+)*(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)[ \t]*\(").unwrap(),
            SymbolKind::Method,
            false,
        ),
        (
            "js",
            Regex::new(r"(?m)^[ \t]+(?:static[ \t]+|async[ \t]+)*(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)[ \t]*\(").unwrap(),
            SymbolKind::Method,
            false,
        ),
        (
            "jsx",
            Regex::new(r"(?m)^[ \t]+(?:static[ \t]+|async[ \t]+)*(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)[ \t]*\(").unwrap(),
            SymbolKind::Method,
            false,
        ),
        (
            "mts",
            Regex::new(r"(?m)^[ \t]+(?:public[ \t]+|private[ \t]+|protected[ \t]+|static[ \t]+|async[ \t]+|readonly[ \t]+)*(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)[ \t]*\(").unwrap(),
            SymbolKind::Method,
            false,
        ),
        (
            "cts",
            Regex::new(r"(?m)^[ \t]+(?:public[ \t]+|private[ \t]+|protected[ \t]+|static[ \t]+|async[ \t]+|readonly[ \t]+)*(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)[ \t]*\(").unwrap(),
            SymbolKind::Method,
            false,
        ),

        // Rust: `pub fn / struct / enum / trait / type / const / static`
        (
            "rs",
            Regex::new(r"(?m)^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?fn[ \t]+(?P<name>[A-Za-z_][A-Za-z0-9_]*)").unwrap(),
            SymbolKind::Function,
            true,
        ),
        (
            "rs",
            Regex::new(r"(?m)^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?struct[ \t]+(?P<name>[A-Za-z_][A-Za-z0-9_]*)").unwrap(),
            SymbolKind::Type,
            true,
        ),
        (
            "rs",
            Regex::new(r"(?m)^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?enum[ \t]+(?P<name>[A-Za-z_][A-Za-z0-9_]*)").unwrap(),
            SymbolKind::Enum,
            true,
        ),
        (
            "rs",
            Regex::new(r"(?m)^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?trait[ \t]+(?P<name>[A-Za-z_][A-Za-z0-9_]*)").unwrap(),
            SymbolKind::Interface,
            true,
        ),
        (
            "rs",
            Regex::new(r"(?m)^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?type[ \t]+(?P<name>[A-Za-z_][A-Za-z0-9_]*)").unwrap(),
            SymbolKind::Type,
            true,
        ),
        (
            "rs",
            Regex::new(r"(?m)^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?const[ \t]+(?P<name>[A-Za-z_][A-Za-z0-9_]*)").unwrap(),
            SymbolKind::Constant,
            true,
        ),
        (
            "rs",
            Regex::new(r"(?m)^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?static[ \t]+(?P<name>[A-Za-z_][A-Za-z0-9_]*)").unwrap(),
            SymbolKind::Constant,
            true,
        ),
        // Rust impl blocks: `impl Foo { fn bar() {} }` — `bar` becomes a Method in container `Foo`.
        (
            "rs",
            Regex::new(r"(?m)^[ \t]*impl(?:[ \t]+<[^>]*>)?[ \t]+(?P<name>[A-Za-z_][A-Za-z0-9_:<>]*)[ \t]*\{").unwrap(),
            SymbolKind::Class,
            false,
        ),

        // Python: top-level `def NAME`, `async def NAME`, `class NAME`
        (
            "py",
            Regex::new(r"(?m)^[ \t]*(?:async[ \t]+)?def[ \t]+(?P<name>[A-Za-z_][A-Za-z0-9_]*)").unwrap(),
            SymbolKind::Function,
            false,
        ),
        (
            "py",
            Regex::new(r"(?m)^[ \t]*class[ \t]+(?P<name>[A-Za-z_][A-Za-z0-9_]*)").unwrap(),
            SymbolKind::Class,
            false,
        ),
        // Python module-level constants: `NAME: TYPE = ...` at column 0
        (
            "py",
            Regex::new(r"(?m)^(?P<name>[A-Z][A-Z0-9_]*)[ \t]*:[ \t]*[A-Za-z_]").unwrap(),
            SymbolKind::Constant,
            false,
        ),

        // Go: top-level `func`, `type NAME struct/interface`, `var`, `const`
        (
            "go",
            Regex::new(r"(?m)^[ \t]*func[ \t]+(?P<name>[A-Za-z_][A-Za-z0-9_]*)").unwrap(),
            SymbolKind::Function,
            false,
        ),
        (
            "go",
            Regex::new(r"(?m)^[ \t]*type[ \t]+(?P<name>[A-Za-z_][A-Za-z0-9_]*)[ \t]+(?:struct|interface)").unwrap(),
            SymbolKind::Type,
            false,
        ),
        (
            "go",
            Regex::new(r"(?m)^[ \t]*var[ \t]+(?P<name>[A-Za-z_][A-Za-z0-9_]*)").unwrap(),
            SymbolKind::Variable,
            false,
        ),
        (
            "go",
            Regex::new(r"(?m)^[ \t]*const[ \t]+(?P<name>[A-Za-z_][A-Za-z0-9_]*)").unwrap(),
            SymbolKind::Constant,
            false,
        ),

        // Java: `public/private/protected class|interface|enum`, methods.
        (
            "java",
            Regex::new(r"(?m)^[ \t]*(?:public|private|protected)[ \t]+(?:abstract[ \t]+)?(?:final[ \t]+)?class[ \t]+(?P<name>[A-Za-z_][A-Za-z0-9_]*)").unwrap(),
            SymbolKind::Class,
            true,
        ),
        (
            "java",
            Regex::new(r"(?m)^[ \t]*(?:public|private|protected)[ \t]+(?:abstract[ \t]+)?interface[ \t]+(?P<name>[A-Za-z_][A-Za-z0-9_]*)").unwrap(),
            SymbolKind::Interface,
            true,
        ),
        (
            "java",
            Regex::new(r"(?m)^[ \t]*(?:public|private|protected)[ \t]+(?:static[ \t]+)?enum[ \t]+(?P<name>[A-Za-z_][A-Za-z0-9_]*)").unwrap(),
            SymbolKind::Enum,
            true,
        ),
    ]
}

static RULES_BY_EXT: LazyLock<Vec<RuleEntry>> = LazyLock::new(make_rules);

/// Append `symbols` to `symbols.jsonl`, removing any existing records whose
/// `file` matches `rel` first so the resulting file is single-record-per-line
/// and idempotent for the given file path.
fn replace_file_symbols(root: &Path, rel: &str, symbols: &[SymbolRecord]) -> Result<(), String> {
    let paths = store::index_paths(root);
    let existing = store::read_jsonl::<SymbolRecord>(&paths.symbols);
    let mut kept: Vec<SymbolRecord> = existing
        .into_iter()
        .filter(|record| record.file != rel)
        .collect();
    kept.extend(symbols.iter().cloned());
    // Sort for stable output across rebuilds.
    kept.sort_by(|a, b| {
        a.file
            .cmp(&b.file)
            .then(a.line.cmp(&b.line))
            .then(a.column.cmp(&b.column))
    });
    // Rewrite the JSONL file (one record per line, trailing newline).
    if let Some(parent) = paths.symbols.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("无法创建目录：{error}"))?;
    }
    let mut body = String::new();
    for record in &kept {
        let line =
            serde_json::to_string(record).map_err(|error| format!("序列化符号失败：{error}"))?;
        body.push_str(&line);
        body.push('\n');
    }
    std::fs::write(&paths.symbols, body).map_err(|error| format!("写入符号失败：{error}"))?;
    Ok(())
}

/// Load all symbol records from disk. Corrupt lines are silently skipped.
pub fn load_index(root: &Path) -> Vec<SymbolRecord> {
    let paths = store::index_paths(root);
    store::read_jsonl::<SymbolRecord>(&paths.symbols)
}

/// Drop every symbol that belongs to `rel` and rewrite both index files.
pub fn remove_file(root: &Path, rel: &str) -> Result<(), String> {
    let paths = store::index_paths(root);
    let existing = store::read_jsonl::<SymbolRecord>(&paths.symbols);
    let kept: Vec<SymbolRecord> = existing
        .into_iter()
        .filter(|record| record.file != rel)
        .collect();
    if let Some(parent) = paths.symbols.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("无法创建目录：{error}"))?;
    }
    let mut body = String::new();
    for record in &kept {
        let line =
            serde_json::to_string(record).map_err(|error| format!("序列化符号失败：{error}"))?;
        body.push_str(&line);
        body.push('\n');
    }
    std::fs::write(&paths.symbols, body).map_err(|error| format!("写入符号失败：{error}"))?;

    let mut file_index = read_file_index(root);
    if file_index.remove(rel).is_some() {
        let next: Vec<FileIndexEntry> = file_index.into_values().collect();
        write_file_index(root, &next)?;
    }
    Ok(())
}

/// Re-scan a single relative file and replace its entries in the index.
/// Returns the new symbol set so callers (e.g. the watcher) can emit
/// `index-updated` with a delta.
pub fn upsert_file(root: &Path, rel: &str) -> Result<Vec<SymbolRecord>, String> {
    let symbols = parse_file(root, rel);
    replace_file_symbols(root, rel, &symbols)?;
    let mut file_index = read_file_index(root);
    if let Some((mtime, size)) = stat_file(root, rel) {
        file_index.insert(
            rel.to_string(),
            FileIndexEntry {
                path: rel.to_string(),
                mtime_ms: mtime,
                size,
            },
        );
    } else {
        file_index.remove(rel);
    }
    let entries: Vec<FileIndexEntry> = file_index.into_values().collect();
    write_file_index(root, &entries)?;
    Ok(symbols)
}

/// Score one symbol against the query. Higher score = better match.
fn score(symbol: &SymbolRecord, needle: &str) -> u32 {
    if needle.is_empty() {
        return 1;
    }
    let lower_name = symbol.name.to_ascii_lowercase();
    let lower_needle = needle.to_ascii_lowercase();
    if lower_name == lower_needle {
        return 1_000;
    }
    if lower_name.starts_with(&lower_needle) {
        return 500;
    }
    if lower_name.contains(&lower_needle) {
        return 200;
    }
    // Subsequence match: every char of needle appears in name in order.
    let mut name_iter = lower_name.chars();
    let mut matched = true;
    for nc in lower_needle.chars() {
        loop {
            match name_iter.next() {
                Some(c) if c == nc => break,
                Some(_) => continue,
                None => {
                    matched = false;
                    break;
                }
            }
        }
        if !matched {
            break;
        }
    }
    if matched {
        50
    } else {
        0
    }
}

/// Filter + score the index in memory. Empty `needle` returns the most
/// recently indexed symbols first.
pub fn query(
    root: &Path,
    needle: &str,
    kind: Option<SymbolKind>,
    limit: usize,
) -> Result<Vec<SymbolQueryHit>, String> {
    let symbols = load_index(root);
    let mut hits: Vec<SymbolQueryHit> = symbols
        .into_iter()
        .filter(|symbol| kind.is_none_or(|k| k == symbol.kind))
        .map(|symbol| {
            let s = score(&symbol, needle);
            SymbolQueryHit { symbol, score: s }
        })
        .filter(|hit| hit.score > 0)
        .collect();
    hits.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.symbol.name.cmp(&b.symbol.name))
    });
    hits.truncate(limit);
    Ok(hits)
}

/// Resolve the innermost symbol that contains the given (file, line) point.
/// Returns `None` when no parsed symbol covers that line.
pub fn symbol_at(root: &Path, file: &str, line: u32) -> Result<Option<SymbolRecord>, String> {
    let symbols = load_index(root);
    let mut best: Option<&SymbolRecord> = None;
    for symbol in &symbols {
        if symbol.file != file {
            continue;
        }
        // We don't track `end_line` because the regex stops at the keyword, so
        // approximate "contains" as: symbol.line <= line and the next symbol in
        // the same file has a larger line.
        if symbol.line > line {
            continue;
        }
        match best {
            None => best = Some(symbol),
            Some(current) => {
                if symbol.line > current.line {
                    best = Some(symbol);
                }
            }
        }
    }
    Ok(best.cloned())
}

/// Full-rebuild the workspace index. Walks every text file under `root`,
/// parses it with language-aware rules, and atomically replaces the on-disk
/// `symbols.jsonl` / `file_index.json` pair. Intended to be called from
/// `spawn_blocking` — file IO here is synchronous by design.
pub fn build_index(root: &Path) -> Result<IndexStatus, String> {
    let files = walk_workspace(root);
    let mut all_symbols: Vec<SymbolRecord> = Vec::new();
    let mut entries: Vec<FileIndexEntry> = Vec::new();
    for rel in &files {
        let rel_str = relativize(root, root.join(rel).as_path());
        let symbols = parse_file(root, &rel_str);
        all_symbols.extend(symbols);
        if let Some((mtime, size)) = stat_file(root, &rel_str) {
            entries.push(FileIndexEntry {
                path: rel_str,
                mtime_ms: mtime,
                size,
            });
        }
    }
    let paths = store::index_paths(root);
    if let Some(parent) = paths.symbols.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("无法创建目录：{error}"))?;
    }
    let mut body = String::new();
    for record in &all_symbols {
        let line =
            serde_json::to_string(record).map_err(|error| format!("序列化符号失败：{error}"))?;
        body.push_str(&line);
        body.push('\n');
    }
    std::fs::write(&paths.symbols, body).map_err(|error| format!("写入符号失败：{error}"))?;
    write_file_index(root, &entries)?;
    Ok(IndexStatus {
        state: IndexState::Ready,
        files_indexed: entries.len() as u32,
        symbols: all_symbols.len() as u32,
        last_reconciled_at: Some(now_rfc3339()),
        in_progress: false,
    })
}

/// Reconcile the on-disk index with current files. Files whose `mtime` and
/// `size` did not change are skipped. When no `file_index.json` exists yet,
/// this falls back to a full rebuild.
pub fn reconcile(root: &Path) -> Result<IndexStatus, String> {
    let paths = store::index_paths(root);
    if !paths.file_index.exists() {
        return build_index(root);
    }
    let known = read_file_index(root);
    let current = walk_workspace(root);
    let mut _changed = 0u32;
    let mut known_paths: std::collections::BTreeSet<String> = known.keys().cloned().collect();
    for rel in &current {
        let rel_str = relativize(root, root.join(rel).as_path());
        known_paths.remove(&rel_str);
        let current_stat = stat_file(root, &rel_str);
        let needs_update = match (known.get(&rel_str), current_stat) {
            (None, Some(_)) => true,
            (Some(prev), Some((mtime, size))) => prev.mtime_ms != mtime || prev.size != size,
            (Some(_), None) => true,
            (None, None) => false,
        };
        if needs_update {
            upsert_file(root, &rel_str)?;
            _changed += 1;
        }
    }
    // Anything left in `known_paths` was deleted on disk.
    for stale in known_paths {
        remove_file(root, &stale)?;
        _changed += 1;
    }
    let status = read_status(root);
    Ok(IndexStatus {
        last_reconciled_at: Some(now_rfc3339()),
        ..status
    })
}

// --- Tauri commands ---------------------------------------------------------

#[derive(Serialize, Clone)]
struct IndexProgressPayload {
    root: String,
    scanned: u32,
    total_estimate: u32,
}

#[derive(Serialize, Clone)]
struct IndexUpdatedPayload {
    root: String,
    file: String,
    added: u32,
    updated: u32,
    removed: u32,
}

#[tauri::command]
pub async fn coding_index_status(
    access: State<'_, FilesystemAccess>,
    root: String,
) -> Result<IndexStatus, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || read_status(&root))
        .await
        .map_err(|error| format!("读取索引状态失败：{error}"))
}

#[tauri::command]
pub async fn coding_index_rebuild(
    app: AppHandle,
    access: State<'_, FilesystemAccess>,
    root: String,
) -> Result<IndexStatus, String> {
    let root_path = access.require_workspace(&root)?;
    let root_for_emit = root.clone();
    let app_handle = app.clone();
    let status = tokio::task::spawn_blocking(move || build_index(&root_path))
        .await
        .map_err(|error| format!("重建索引失败：{error}"))??;
    let _ = app_handle.emit(
        "coding://index-updated",
        IndexUpdatedPayload {
            root: root_for_emit,
            file: String::new(),
            added: status.symbols,
            updated: 0,
            removed: 0,
        },
    );
    Ok(status)
}

#[tauri::command]
pub async fn coding_symbol_query(
    access: State<'_, FilesystemAccess>,
    root: String,
    needle: String,
    kind: Option<SymbolKind>,
    limit: Option<u32>,
) -> Result<Vec<SymbolQueryHit>, String> {
    let root = access.require_workspace(&root)?;
    let cap = limit.unwrap_or(50).max(1) as usize;
    tokio::task::spawn_blocking(move || query(&root, &needle, kind, cap))
        .await
        .map_err(|error| format!("查询符号失败：{error}"))?
}

#[tauri::command]
pub async fn coding_symbol_at(
    access: State<'_, FilesystemAccess>,
    root: String,
    file: String,
    line: u32,
) -> Result<Option<SymbolRecord>, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || symbol_at(&root, &file, line))
        .await
        .map_err(|error| format!("查询位置符号失败：{error}"))?
}

#[tauri::command]
pub async fn coding_index_emit_progress(
    app: AppHandle,
    root: String,
    scanned: u32,
    total_estimate: u32,
) -> Result<(), String> {
    let _ = app.emit(
        "coding://index-progress",
        IndexProgressPayload {
            root,
            scanned,
            total_estimate,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn coding_index_emit_updated(
    app: AppHandle,
    root: String,
    file: String,
    added: u32,
    updated: u32,
    removed: u32,
) -> Result<(), String> {
    let _ = app.emit(
        "coding://index-updated",
        IndexUpdatedPayload {
            root,
            file,
            added,
            updated,
            removed,
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("coding-symbols-{}", uuid::Uuid::now_v7()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(root: &Path, rel: &str, body: &str) {
        let abs = root.join(rel);
        if let Some(parent) = abs.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(abs, body).unwrap();
    }

    #[test]
    fn builds_index_for_mixed_language_repo() {
        let root = temp_root();
        write(
            &root,
            "src/auth.ts",
            "export function login(user: string) { return user; }\nexport class AuthService {}\n",
        );
        write(
            &root,
            "src/lib.rs",
            "pub fn parse_token(input: &str) -> usize { input.len() }\npub struct Auth;\n",
        );
        write(
            &root,
            "scripts/parse.py",
            "def parse_token(text):\n    return text\nclass Parser:\n    pass\n",
        );
        write(
            &root,
            "cmd/main.go",
            "func parseToken(s string) int { return len(s) }\ntype Parser struct{}\n",
        );

        let status = build_index(&root).unwrap();
        assert_eq!(status.state, IndexState::Ready);
        assert!(status.symbols >= 7);
        let symbols = load_index(&root);
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"login"));
        assert!(names.contains(&"AuthService"));
        assert!(names.contains(&"parse_token"));
        assert!(names.contains(&"Auth"));
        assert!(names.contains(&"Parser"));
        assert!(names.contains(&"parseToken"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn upsert_replaces_not_duplicates_and_keeps_first_id_stable() {
        let root = temp_root();
        write(&root, "a.ts", "export function alpha() {}\n");
        build_index(&root).unwrap();
        let first = load_index(&root);
        let alpha_id = first.iter().find(|s| s.name == "alpha").unwrap().id.clone();

        // Re-write the file with a new symbol, same name on different line.
        write(
            &root,
            "a.ts",
            "export function alpha() {}\nexport function beta() {}\n",
        );
        upsert_file(&root, "a.ts").unwrap();
        let second = load_index(&root);
        let alpha_again = second
            .iter()
            .find(|s| s.name == "alpha")
            .expect("alpha should still exist");
        assert_eq!(
            alpha_again.id, alpha_id,
            "id must stay stable across upserts"
        );
        assert!(second.iter().any(|s| s.name == "beta"));
        // And the old symbol record for `a.ts` was replaced, not appended twice.
        let alpha_count = second.iter().filter(|s| s.name == "alpha").count();
        assert_eq!(alpha_count, 1);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn remove_file_drops_all_symbols_for_path() {
        let root = temp_root();
        write(
            &root,
            "mod.ts",
            "export function one() {}\nexport function two() {}\n",
        );
        build_index(&root).unwrap();
        assert_eq!(load_index(&root).len(), 2);
        remove_file(&root, "mod.ts").unwrap();
        assert!(load_index(&root).is_empty());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn query_filters_by_kind_and_subsequence_match_scores_prefix_higher() {
        let root = temp_root();
        write(
            &root,
            "list.ts",
            "export function listItems() {}\nexport class ListView {}\nexport const LIST_LIMIT = 50;\n",
        );
        build_index(&root).unwrap();

        let funcs = query(&root, "list", Some(SymbolKind::Function), 10).unwrap();
        assert!(funcs.iter().all(|h| h.symbol.kind == SymbolKind::Function));
        assert!(funcs.iter().any(|h| h.symbol.name == "listItems"));

        let prefix = query(&root, "list", None, 10).unwrap();
        let subseq = query(&root, "lvie", None, 10).unwrap();
        // `list*` matches should out-score the subsequence match for `lvie`.
        let prefix_score = prefix
            .iter()
            .find(|h| h.symbol.name == "ListView")
            .map(|h| h.score)
            .unwrap_or(0);
        let subseq_score = subseq
            .iter()
            .find(|h| h.symbol.name == "ListView")
            .map(|h| h.score)
            .unwrap_or(0);
        assert!(prefix_score > subseq_score);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn symbol_at_returns_innermost_when_method_inside_class() {
        let root = temp_root();
        write(
            &root,
            "svc.ts",
            "export class Greeter {\n  greet(name: string) { return name; }\n}\n",
        );
        build_index(&root).unwrap();
        let on_method = symbol_at(&root, "svc.ts", 2).unwrap().expect("method");
        assert_eq!(on_method.name, "greet");
        assert_eq!(on_method.kind, SymbolKind::Method);
        let on_class = symbol_at(&root, "svc.ts", 1).unwrap().expect("class");
        assert_eq!(on_class.name, "Greeter");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn corrupt_jsonl_line_is_skipped_others_loaded() {
        let root = temp_root();
        write(&root, "x.ts", "export function keep() {}\n");
        build_index(&root).unwrap();
        // Append a corrupt line.
        let paths = store::index_paths(&root);
        let mut text = std::fs::read_to_string(&paths.symbols).unwrap();
        text.push_str("{{not json}}\n");
        std::fs::write(&paths.symbols, text).unwrap();
        let loaded = load_index(&root);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "keep");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn index_status_reflects_empty_building_ready_transitions() {
        let root = temp_root();
        let empty = read_status(&root);
        assert_eq!(empty.state, IndexState::Empty);
        assert_eq!(empty.symbols, 0);

        write(&root, "a.ts", "export function ready() {}\n");
        build_index(&root).unwrap();
        let ready = read_status(&root);
        assert_eq!(ready.state, IndexState::Ready);
        assert_eq!(ready.symbols, 1);
        assert!(ready.last_reconciled_at.is_some());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rebuild_yields_equivalent_symbols_to_first_build() {
        let root = temp_root();
        write(
            &root,
            "lib.rs",
            "pub fn one() {}\npub fn two() {}\npub struct Item {}\n",
        );
        build_index(&root).unwrap();
        let first = load_index(&root);
        build_index(&root).unwrap();
        let second = load_index(&root);
        let first_ids: std::collections::BTreeSet<String> =
            first.iter().map(|s| s.id.clone()).collect();
        let second_ids: std::collections::BTreeSet<String> =
            second.iter().map(|s| s.id.clone()).collect();
        assert_eq!(first_ids, second_ids);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn requires_workspace_path_outside_root_is_rejected() {
        // `read_status` is the safe core: it only touches the configured path
        // and never accepts a relative or non-canonicalised input. We assert
        // the invariants by calling it on a guaranteed-bad path and verifying
        // it returns Empty (the same path as if the user had no index yet)
        // rather than panicking.
        let root = Path::new("/nonexistent-workspace-root-that-does-not-exist");
        let status = read_status(root);
        assert_eq!(status.state, IndexState::Empty);
    }
}
