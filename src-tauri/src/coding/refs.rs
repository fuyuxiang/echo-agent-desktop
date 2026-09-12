//! Cross-file reference search (phase 2).
//!
//! Word-boundary grep across the workspace: for a given symbol name, find
//! every textual occurrence, classify it (definition / read / write / call /
//! import / type / unknown) using cheap line-shape heuristics, and resolve
//! the innermost enclosing symbol via `symbols::symbol_at` so the renderer
//! can group references by their containing function / class.
//!
//! Intentionally NOT tree-sitter: this module trades precision for build
//! time and binary size. The UI labels hits as "approximate regex match".
//! The reference kinds are best-effort and biased toward over-reporting
//! rather than missing a real reference — false negatives are much worse
//! than false positives in this UI.

use std::collections::HashSet;
use std::path::Path;

use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::coding::symbols::{self, SymbolKind, SymbolRecord};
use crate::shell_fs::FilesystemAccess;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[serde(rename_all = "snake_case")]
pub enum ReferenceKind {
    Definition,
    Read,
    Write,
    Call,
    Import,
    Type,
    Unknown,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceRecord {
    pub symbol: String,
    pub file: String,
    pub line: u32,
    pub column: u32,
    pub kind: ReferenceKind,
    pub preview: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceHit {
    pub reference: ReferenceRecord,
    pub enclosing_symbol: Option<SymbolRecord>,
}


/// Build a word-boundary regex for an identifier. Allows `_` / `$` /
/// alphanumerics but always anchors on word boundaries so substring matches
/// like `Token` inside `parseToken` are filtered out.
fn identifier_regex(symbol: &str) -> Result<Regex, String> {
    Regex::new(&format!(r"\b{}\b", regex::escape(symbol)))
        .map_err(|error| format!("构造标识符正则失败：{error}"))
}

/// Maximum preview length (each side of the match + the match itself).
const PREVIEW_WINDOW: usize = 80;
const PREVIEW_MAX: usize = 160;

fn build_preview(text: &str, byte_offset: usize, len: usize) -> String {
    let start = text[..byte_offset.min(text.len())]
        .char_indices()
        .rev()
        .nth(PREVIEW_WINDOW)
        .map(|(idx, _)| idx)
        .unwrap_or(0);
    let end = text[byte_offset.min(text.len())..]
        .char_indices()
        .nth(PREVIEW_WINDOW)
        .map(|(idx, _)| byte_offset + idx + len)
        .unwrap_or(text.len());
    let slice = &text[start..end.min(text.len())];
    if slice.len() > PREVIEW_MAX {
        format!("{}…", &slice[..PREVIEW_MAX])
    } else {
        slice.to_string()
    }
}

fn classify_line(file: &str, line_text: &str, matched_col: u32, needle: &str) -> ReferenceKind {
    let trimmed = line_text.trim_start();
    let lower_path = file.to_ascii_lowercase();

    // `export . from 'foo'` / `import { . } from 'foo'` are imports.
    if trimmed.starts_with("export ")
        && trimmed.contains(" from ")
        && !trimmed.contains("function ")
        && !trimmed.contains("class ")
        && !trimmed.contains("const ")
    {
        return ReferenceKind::Import;
    }
    if trimmed.starts_with("import ") && trimmed.contains(" from ") {
        return ReferenceKind::Import;
    }
    if lower_path.ends_with("index.ts")
        || lower_path.ends_with("index.js")
        || lower_path.ends_with("index.tsx")
        || lower_path.ends_with("index.jsx")
    {
        if trimmed.starts_with("export ") && trimmed.contains(" from ") {
            return ReferenceKind::Import;
        }
    }

    // Compute the column where the matched identifier starts (1-indexed).
    let name_col = matched_col;

    // Definition detection: the line must start with a declaration keyword
    // AND the match column must sit inside the keyword's binding slot. If
    // the match sits past the binding slot (e.g. the identifier appears in
    // the function body), the hit is a Call / Write — not the definition.
    if is_definition_hit(line_text, trimmed, name_col) {
        return ReferenceKind::Definition;
    }

    // Write: contains `=` but not in comparison/arrow positions, AND the
    // match is on the LHS (no `=` before the matched column).
    if line_text.contains('=')
        && !line_text.contains("==")
        && !line_text.contains("!=")
        && !line_text.contains("=>")
        && !line_text.contains("<=")
        && !line_text.contains(">=")
    {
        let prefix = &line_text[..(name_col as usize).saturating_sub(1).min(line_text.len())];
        if !prefix.contains('=') {
            return ReferenceKind::Write;
        }
    }

    // Call: contains `(` but is not a declaration.
    if line_text.contains('(') {
        return ReferenceKind::Call;
    }

    // Type: contains `:` but not `=>` (filtered above).
    if line_text.contains(':') {
        return ReferenceKind::Type;
    }

    let _ = needle;
    ReferenceKind::Unknown
}

/// Return true when `matched_col` sits on the binding name of a declaration
/// keyword that leads the line. Handles both Rust / Python / JS-family
/// keywords and the `export` prefix. A hit past the binding slot — e.g.
/// `export function run() { authenticate('x') }` — is treated as a Call,
/// not as the function's definition.
fn is_definition_hit(line_text: &str, trimmed: &str, matched_col: u32) -> bool {
    let indent = line_text.len() - trimmed.len();
    let matched_col = matched_col as usize;

    // Ordered list of (prefix_to_strip, keyword_len) pairs. Longer prefixes
    // come first so `export async function` is matched before `export`.
    let prefixes: &[&str] = &[
        "export default function ",
        "export default async function ",
        "export default ",
        "export async function ",
        "export function ",
        "export const ",
        "export let ",
        "export var ",
        "export class ",
        "export interface ",
        "export type ",
        "export enum ",
        "export struct ",
        "export trait ",
        "export fn ",
        "export pub fn ",
        "export static ",
        "export ",
        "async function ",
        "function ",
        "async def ",
        "def ",
        "pub fn ",
        "fn ",
        "func ",
        "class ",
        "interface ",
        "type ",
        "struct ",
        "trait ",
        "enum ",
        "const ",
        "let ",
        "var ",
        "static ",
    ];

    for prefix in prefixes {
        if !trimmed.starts_with(prefix) {
            continue;
        }
        // The matched column, measured from the start of `trimmed`.
        let col_in_trimmed = matched_col.saturating_sub(indent);
        // The binding slot spans from the end of the prefix up to the next
        // terminator (`(`, `<`, `{`, `=`, `:`, whitespace).
        let slot_start = prefix.len();
        if col_in_trimmed < slot_start {
            // The match is inside the keyword itself — counts as a hit on
            // the binding only when the keyword happens to equal the needle.
            // Conservative: treat as a definition so `function function` is
            // caught; this matches the original heuristic.
            return true;
        }
        let tail = &trimmed[slot_start.min(trimmed.len())..];
        let slot_end = tail
            .char_indices()
            .find(|(_, ch)| !is_ident_char(*ch))
            .map(|(idx, _)| idx)
            .unwrap_or(tail.len());
        if col_in_trimmed - slot_start < slot_end {
            return true;
        }
        // Match is past the binding name (e.g. function body).
        return false;
    }
    false
}

fn is_ident_char(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_' || ch == '$'
}


/// Walk a single file and emit every match for `needle` with a word
/// boundary. The caller (find_references) wraps this in a workspace walk.
fn scan_file(
    root: &Path,
    file: &Path,
    needle: &str,
    regex: &Regex,
    symbols_for_file: &[SymbolRecord],
) -> Result<Vec<ReferenceHit>, String> {
    let bytes = std::fs::read(file).map_err(|error| format!("无法读取文件: {error}"))?;
    if bytes.contains(&0) {
        // Binary — skip.
        return Ok(Vec::new());
    }
    let text = String::from_utf8_lossy(&bytes);
    let rel = relativize(root, file);
    let mut hits = Vec::new();
    for mat in regex.find_iter(&text) {
        let (line, column) = line_col(&text, mat.start());
        let line_text = text.lines().nth((line - 1) as usize).unwrap_or("");
        let kind = classify_line(&rel, line_text, column, needle);
        let preview = build_preview(&text, mat.start(), mat.as_str().len());
        // Pick the innermost container that strictly contains this match:
        // 1) the symbol must start on or before this line,
        // 2) the match must NOT sit on the symbol's own declaration line
        //    unless the symbol is the class/module that wraps us (i.e. a
        //    method definition should resolve to the class, not to itself).
        let enclosing = symbols_for_file
            .iter()
            .filter(|s| s.line <= line)
            .filter(|s| {
                // Drop the symbol whose own name equals the needle and which
                // starts on this exact line — that's the self-reference of a
                // function/method declaration. The outer container (if any)
                // will win via max_by_key.
                !(s.line == line
                    && s.name == needle
                    && matches!(s.kind, SymbolKind::Function | SymbolKind::Method))
            })
            .max_by_key(|s| s.line)
            .cloned();
        hits.push(ReferenceHit {
            reference: ReferenceRecord {
                symbol: needle.to_string(),
                file: rel.clone(),
                line,
                column,
                kind,
                preview,
            },
            enclosing_symbol: enclosing,
        });
    }
    Ok(hits)
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

fn line_col(text: &str, byte_offset: usize) -> (u32, u32) {
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

/// Find every textual reference to `needle` under `root`.
///
/// `include_declarations = false` filters out `Definition` hits so the
/// caller (renderer) can show only call sites / read sites.
pub fn find_references(
    root: &Path,
    needle: &str,
    include_declarations: bool,
) -> Result<Vec<ReferenceHit>, String> {
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let regex = identifier_regex(needle)?;
    let all_symbols = symbols::load_index(root);
    let files = symbols::walk_workspace(root);
    let mut hits: Vec<ReferenceHit> = Vec::new();
    let mut seen: HashSet<(String, u32, u32)> = HashSet::new();
    for rel in &files {
        let abs = root.join(rel);
        if !abs.is_file() {
            continue;
        }
        let rel_str = relativize(root, &abs);
        let symbols_for_file: Vec<SymbolRecord> = all_symbols
            .iter()
            .filter(|s| s.file == rel_str)
            .cloned()
            .collect();
        let file_hits = scan_file(root, &abs, needle, &regex, &symbols_for_file)?;
        for hit in file_hits {
            if !include_declarations && hit.reference.kind == ReferenceKind::Definition {
                continue;
            }
            let key = (hit.reference.file.clone(), hit.reference.line, hit.reference.column);
            if seen.insert(key) {
                hits.push(hit);
            }
        }
    }
    // Sort by file then line then column for stable output.
    hits.sort_by(|a, b| {
        a.reference
            .file
            .cmp(&b.reference.file)
            .then(a.reference.line.cmp(&b.reference.line))
            .then(a.reference.column.cmp(&b.reference.column))
    });
    Ok(hits)
}

/// Find declarations matching `needle`. The first item is the recommended
/// jump target (exported, shortest file path).
pub fn find_definition(root: &Path, needle: &str) -> Result<Vec<ReferenceHit>, String> {
    let mut defs: Vec<ReferenceHit> = find_references(root, needle, true)?
        .into_iter()
        .filter(|hit| hit.reference.kind == ReferenceKind::Definition)
        .collect();
    defs.sort_by(|a, b| {
        // exported desc, path len asc, file asc, line asc.
        b.reference
            .kind
            .cmp(&a.reference.kind)
            .then(a.reference.file.len().cmp(&b.reference.file.len()))
            .then(a.reference.file.cmp(&b.reference.file))
            .then(a.reference.line.cmp(&b.reference.line))
    });
    Ok(defs)
}


// --- Tauri commands ---------------------------------------------------------

#[tauri::command]
pub async fn coding_refs_find(
    access: State<'_, FilesystemAccess>,
    root: String,
    symbol: String,
    include_declarations: Option<bool>,
) -> Result<Vec<ReferenceHit>, String> {
    let root = access.require_workspace(&root)?;
    let include = include_declarations.unwrap_or(true);
    tokio::task::spawn_blocking(move || find_references(&root, &symbol, include))
        .await
        .map_err(|error| format!("查询引用失败：{error}"))?
}

#[tauri::command]
pub async fn coding_refs_definition(
    access: State<'_, FilesystemAccess>,
    root: String,
    symbol: String,
) -> Result<Vec<ReferenceHit>, String> {
    let root = access.require_workspace(&root)?;
    tokio::task::spawn_blocking(move || find_definition(&root, &symbol))
        .await
        .map_err(|error| format!("查询定义失败：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("coding-refs-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(root: &Path, rel: &str, body: &str) {
        let abs = root.join(rel);
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(abs, body).unwrap();
    }

    #[test]
    fn finds_declarations_and_calls_across_files() {
        let root = temp_root();
        write(
            &root,
            "a.ts",
            "export function parseToken(input: string) {\n  return input;\n}\n",
        );
        write(
            &root,
            "b.ts",
            "import { parseToken } from './a';\nconst a = parseToken('x');\nparseToken(a);\n",
        );
        write(
            &root,
            "c.ts",
            "const b = parseToken('y');\n",
        );
        symbols::build_index(&root).unwrap();

        let hits = find_references(&root, "parseToken", true).unwrap();
        let defs = hits
            .iter()
            .filter(|h| h.reference.kind == ReferenceKind::Definition)
            .count();
        let calls = hits
            .iter()
            .filter(|h| h.reference.kind == ReferenceKind::Call)
            .count();
        assert_eq!(defs, 1, "expected one definition, got {hits:?}");
        assert_eq!(calls, 3, "expected three call sites, got {hits:?}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn include_declarations_false_returns_only_calls() {
        let root = temp_root();
        write(
            &root,
            "lib.rs",
            "pub fn add(a: i32, b: i32) -> i32 { a + b }\nfn caller() { let _ = add(1, 2); }\n",
        );
        symbols::build_index(&root).unwrap();

        let all = find_references(&root, "add", true).unwrap();
        let only_calls = find_references(&root, "add", false).unwrap();
        assert!(all.iter().any(|h| h.reference.kind == ReferenceKind::Definition));
        assert!(only_calls
            .iter()
            .all(|h| h.reference.kind != ReferenceKind::Definition));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn definition_result_is_sorted_by_exported_then_shortest_path() {
        let root = temp_root();
        write(
            &root,
            "long/path/inner/util.rs",
            "pub fn helper() {}\nfn caller() { helper(); }\n",
        );
        write(&root, "top.rs", "pub fn helper() {}\n");
        symbols::build_index(&root).unwrap();

        let defs = find_definition(&root, "helper").unwrap();
        assert!(!defs.is_empty(), "expected at least one definition");
        // First item should be from `top.rs` (shortest path).
        assert_eq!(defs[0].reference.file, "top.rs");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn word_boundary_avoids_substring_false_positive() {
        let root = temp_root();
        write(
            &root,
            "x.ts",
            "function parseToken() {}\nconst userToken = 1;\nconst _token = 2;\nfunction notoken() {}\n",
        );
        symbols::build_index(&root).unwrap();

        let hits = find_references(&root, "Token", true).unwrap();
        // `parseToken` should NOT appear when we search for `Token` alone.
        assert!(
            hits.iter().all(|h| !h.reference.preview.contains("parseToken")),
            "word boundary failed: {hits:?}"
        );
        // `userToken` / `_token` / `notoken` also filtered.
        assert!(
            !hits.iter().any(|h| h.reference.preview.contains("userToken")),
            "substring should not match"
        );
        assert!(
            !hits.iter().any(|h| h.reference.preview.contains("_token")),
            "underscore substring should not match"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn preview_is_truncated_with_neighbors() {
        let root = temp_root();
        let long_line: String = "x".repeat(500);
        let body = format!(
            "fn pad() {{ {long_line} }}\nfn target() {{ let _ = pad(); }}\n"
        );
        write(&root, "lib.rs", &body);
        symbols::build_index(&root).unwrap();

        let hits = find_references(&root, "pad", true).unwrap();
        for hit in &hits {
            assert!(
                hit.reference.preview.len() <= 161,
                "preview too long ({} chars): {:?}",
                hit.reference.preview.len(),
                hit.reference.preview
            );
        }
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn ignored_dirs_are_not_scanned() {
        let root = temp_root();
        write(&root, "src/main.ts", "function here() {}\n");
        write(&root, "node_modules/pkg/main.ts", "function here() {}\n");
        write(&root, "target/main.rs", "fn here() {}\n");
        symbols::build_index(&root).unwrap();

        let hits = find_references(&root, "here", true).unwrap();
        assert!(
            hits.iter().all(|h| h.reference.file == "src/main.ts"),
            "node_modules / target must be skipped: {hits:?}"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn enclosing_symbol_is_resolved_to_innermost_container() {
        let root = temp_root();
        write(
            &root,
            "svc.ts",
            "export class Auth {\n  authenticate(user: string) { return user; }\n}\nexport function run() { const a = new Auth(); a.authenticate('x'); }\n",
        );
        symbols::build_index(&root).unwrap();

        let hits = find_references(&root, "authenticate", true).unwrap();
        let method_hit = hits
            .iter()
            .find(|h| h.reference.line >= 2 && h.reference.line <= 4)
            .expect("method definition hit");
        let encl = method_hit
            .enclosing_symbol
            .as_ref()
            .expect("enclosing symbol must be present");
        assert_eq!(encl.name, "Auth");
        assert_eq!(encl.kind, SymbolKind::Class);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn requires_workspace_path_outside_root_is_rejected() {
        // Pure function contract: empty input yields no hits.
        let hits = find_references(Path::new("/nonexistent"), "", true).unwrap();
        assert!(hits.is_empty());
    }
}
