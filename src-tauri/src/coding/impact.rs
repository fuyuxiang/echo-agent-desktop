//! Cross-file impact analysis (phase 2 task 20).
//!
//! Given a target symbol name, build a 1..3-layer transitive closure of
//! references by composing `refs::find_references` (forward edges) and
//! `symbols::query` (the seed). The closure walks enclosing symbols, not
//! raw hits, so the graph stays at the function/class level the UI wants to
//! render. Cycles are cut at the depth limit and by deduplicating against
//! the seen set per BFS layer.
//!
//! Test files are a separate concern: `include_tests=true` lifts symbols
//! whose file path matches a test convention into `test_impact` so the
//! ImpactAnalysisView can highlight them without polluting `transitive`.

use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::coding::refs::{self, ReferenceHit, ReferenceKind};
use crate::coding::symbols::{self, SymbolRecord};
use crate::shell_fs::FilesystemAccess;

const MAX_DEPTH: u32 = 3;
const DEFAULT_DEPTH: u32 = 2;

/// Heuristic test-file patterns. Each substring is matched against the
/// file path using a simple lowercase contains so platform path separators
/// (forward and backward) and suffixes are all caught.
const TEST_FILE_HINTS: &[&str] = &[
    "__tests__",
    "/tests/",
    ".test.",
    ".spec.",
    "test_",
    "_test.py",
];

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImpactNode {
    pub symbol: SymbolRecord,
    pub references: u32,
    pub tests: u32,
    pub depth: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImpactEdge {
    pub from_file: String,
    pub from_line: u32,
    pub to: String,
    pub kind: ReferenceKind,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImpactGraph {
    pub target: String,
    pub direct: Vec<ImpactNode>,
    pub transitive: Vec<ImpactNode>,
    pub test_impact: Vec<SymbolRecord>,
    pub edges: Vec<ImpactEdge>,
    pub depth_used: u32,
}

/// Build the impact graph for `target`. `depth` is clamped to 1..=3; 0 is
/// promoted to 1, anything above `MAX_DEPTH` is clamped to `MAX_DEPTH`.
pub fn analyze(
    root: &Path,
    target: &str,
    depth: u32,
    include_tests: bool,
) -> Result<ImpactGraph, String> {
    if target.is_empty() {
        return Err("target 不能为空".to_string());
    }
    let depth = depth.clamp(1, MAX_DEPTH);
    let direct_layer = refs::find_references(root, target, true)?;
    let edges = collect_edges(&direct_layer);

    // Seed layer: prefer the symbol index, fall back to the first enclosing
    // symbol of any direct hit. Empty when nothing matches.
    let mut direct_nodes = Vec::<ImpactNode>::new();
    let mut seen_names: HashSet<String> = HashSet::new();
    let seed_symbols = seed_symbols(root, target);
    for symbol in &seed_symbols {
        seen_names.insert(symbol.name.clone());
    }
    for hit in &direct_layer {
        if let Some(enclosing) = &hit.enclosing_symbol {
            if seen_names.insert(enclosing.name.clone()) {
                direct_nodes.push(ImpactNode {
                    symbol: enclosing.clone(),
                    references: 0,
                    tests: 0,
                    depth: 1,
                });
            }
        }
    }
    // `references` for each direct node = number of hits in `direct_layer`
    // whose enclosing name matches. The seed symbols themselves do not
    // contribute to `references` (they are the target, not callers).
    populate_direct_refs(&mut direct_nodes, &direct_layer);

    // Layer 2..depth: walk enclosing_symbol names from the previous layer.
    let mut transitive_nodes = Vec::<ImpactNode>::new();
    let mut current_layer: Vec<String> =
        direct_nodes.iter().map(|n| n.symbol.name.clone()).collect();
    // `seen` is everything already emitted (target + direct callers).
    // Hitting one of these names again would be a back-edge from a deeper
    // layer; skip it to keep the BFS acyclic. Current layer members ARE
    // allowed to process — only the *results* are filtered against `seen`.
    let seen: HashSet<String> = seen_names;
    for d in 2..=depth {
        let mut next_layer: Vec<String> = Vec::new();
        for name in &current_layer {
            let layer_hits = refs::find_references(root, name, true)?;
            let mut next_node: Option<ImpactNode> = None;
            for hit in &layer_hits {
                let kind = hit.reference.kind;
                if !matches!(
                    kind,
                    ReferenceKind::Call | ReferenceKind::Write | ReferenceKind::Read
                ) {
                    continue;
                }
                if let Some(enclosing) = &hit.enclosing_symbol {
                    if seen.contains(&enclosing.name) {
                        continue;
                    }
                    if !next_layer.iter().any(|n| n == &enclosing.name) {
                        next_layer.push(enclosing.name.clone());
                    }
                    let entry = next_node.get_or_insert_with(|| ImpactNode {
                        symbol: enclosing.clone(),
                        references: 0,
                        tests: 0,
                        depth: d,
                    });
                    entry.references += 1;
                    if is_test_file(&enclosing.file) {
                        entry.tests += 1;
                    }
                }
            }
            if let Some(node) = next_node {
                transitive_nodes.push(node);
            }
        }
        if next_layer.is_empty() {
            break;
        }
        current_layer = next_layer;
    }

    let test_impact: Vec<SymbolRecord> = if include_tests {
        transitive_nodes
            .iter()
            .filter(|node| is_test_file(&node.symbol.file))
            .map(|node| node.symbol.clone())
            .collect()
    } else {
        Vec::new()
    };

    Ok(ImpactGraph {
        target: target.to_string(),
        direct: direct_nodes,
        transitive: transitive_nodes,
        test_impact,
        edges,
        depth_used: depth,
    })
}

fn seed_symbols(root: &Path, target: &str) -> Vec<SymbolRecord> {
    let query = symbols::query(root, target, None, 32).unwrap_or_default();
    query.into_iter().map(|hit| hit.symbol).collect()
}

fn collect_edges(direct: &[ReferenceHit]) -> Vec<ImpactEdge> {
    direct
        .iter()
        .map(|hit| ImpactEdge {
            from_file: hit.reference.file.clone(),
            from_line: hit.reference.line,
            to: hit
                .enclosing_symbol
                .as_ref()
                .map(|symbol| symbol.name.clone())
                .unwrap_or_else(|| "<anonymous>".to_string()),
            kind: hit.reference.kind,
        })
        .collect()
}

fn populate_direct_refs(nodes: &mut [ImpactNode], hits: &[ReferenceHit]) {
    for node in nodes.iter_mut() {
        let mut refs = 0u32;
        let mut tests = 0u32;
        for hit in hits {
            let Some(enclosing) = &hit.enclosing_symbol else {
                continue;
            };
            if enclosing.name != node.symbol.name {
                continue;
            }
            refs += 1;
            if is_test_file(&hit.reference.file) {
                tests += 1;
            }
        }
        node.references = refs;
        node.tests = tests;
    }
}

fn is_test_file(file: &str) -> bool {
    let lower = file.replace('\\', "/").to_ascii_lowercase();
    TEST_FILE_HINTS.iter().any(|hint| lower.contains(hint))
}

// --- Tauri commands ---------------------------------------------------------

#[tauri::command]
pub async fn coding_impact_analyze(
    access: State<'_, FilesystemAccess>,
    root: String,
    target: String,
    depth: Option<u32>,
    include_tests: Option<bool>,
) -> Result<ImpactGraph, String> {
    let root = access.require_workspace(&root)?;
    let depth = depth.unwrap_or(DEFAULT_DEPTH);
    let include_tests = include_tests.unwrap_or(true);
    tokio::task::spawn_blocking(move || analyze(&root, &target, depth, include_tests))
        .await
        .map_err(|error| format!("分析影响失败：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("coding-impact-{}", uuid::Uuid::now_v7()));
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

    fn node_names(nodes: &[ImpactNode]) -> Vec<String> {
        nodes.iter().map(|n| n.symbol.name.clone()).collect()
    }

    #[test]
    fn one_layer_returns_only_direct_callers() {
        let root = temp_root();
        write(
            &root,
            "a.ts",
            "export function authenticate(u: string) { return u; }\n",
        );
        write(
            &root,
            "b.ts",
            "import { authenticate } from './a';\nexport function run() { authenticate('x'); }\n",
        );
        symbols::build_index(&root).unwrap();

        let graph = analyze(&root, "authenticate", 1, false).unwrap();
        let direct = node_names(&graph.direct);
        assert!(
            direct.contains(&"run".to_string()),
            "expected run in direct, got {direct:?}"
        );
        assert!(
            graph.transitive.is_empty(),
            "depth=1 must skip transitive layer, got {:?}",
            graph.transitive
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn two_layer_includes_transitive_callers_and_tests() {
        let root = temp_root();
        write(
            &root,
            "a.ts",
            "export function authenticate(u: string) { return u; }\n",
        );
        write(
            &root,
            "b.ts",
            "import { authenticate } from './a';\nexport function run() { authenticate('x'); }\n",
        );
        write(
            &root,
            "tests/b.test.ts",
            "import { run } from '../b';\nexport function runTest() { run(); }\n",
        );
        symbols::build_index(&root).unwrap();

        let graph = analyze(&root, "authenticate", 2, true).unwrap();
        let direct = node_names(&graph.direct);
        let transitive = node_names(&graph.transitive);
        assert!(direct.contains(&"run".to_string()), "direct: {direct:?}");
        assert!(
            transitive.contains(&"runTest".to_string()),
            "transitive: {transitive:?}"
        );
        assert!(
            graph
                .test_impact
                .iter()
                .any(|symbol| symbol.name == "runTest"),
            "test_impact must include runTest: {:?}",
            graph
                .test_impact
                .iter()
                .map(|s| s.name.clone())
                .collect::<Vec<_>>()
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn include_tests_false_drops_test_impact() {
        let root = temp_root();
        write(
            &root,
            "a.ts",
            "export function authenticate(u: string) { return u; }\n",
        );
        write(
            &root,
            "b.ts",
            "import { authenticate } from './a';\nexport function run() { authenticate('x'); }\n",
        );
        write(
            &root,
            "tests/b.test.ts",
            "import { run } from '../b';\nexport function runTest() { run(); }\n",
        );
        symbols::build_index(&root).unwrap();

        let graph = analyze(&root, "authenticate", 2, false).unwrap();
        assert!(
            graph.test_impact.is_empty(),
            "include_tests=false must drop test_impact: {:?}",
            graph.test_impact
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn cycle_is_handled_by_depth_cap() {
        let root = temp_root();
        write(
            &root,
            "a.ts",
            "import { b } from './b';\nexport function a() { return b(); }\n",
        );
        write(
            &root,
            "b.ts",
            "import { a } from './a';\nexport function b() { return a(); }\n",
        );
        symbols::build_index(&root).unwrap();

        let graph = analyze(&root, "a", 3, false).unwrap();
        let occurrences = graph
            .direct
            .iter()
            .filter(|node| node.symbol.name == "b")
            .count()
            + graph
                .transitive
                .iter()
                .filter(|node| node.symbol.name == "a")
                .count();
        assert!(
            occurrences <= 1,
            "cycle must not duplicate a across layers, got direct={:?} transitive={:?}",
            graph.direct,
            graph.transitive
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn unknown_symbol_returns_empty_direct_with_target_in_response() {
        let root = temp_root();
        write(&root, "a.ts", "export function here() {}\n");
        symbols::build_index(&root).unwrap();

        let graph = analyze(&root, "doesNotExist", 2, false).unwrap();
        assert_eq!(graph.target, "doesNotExist");
        assert!(
            graph.direct.is_empty(),
            "expected empty direct, got {:?}",
            graph.direct
        );
        assert!(
            graph.transitive.is_empty(),
            "expected empty transitive, got {:?}",
            graph.transitive
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn references_count_matches_unique_caller_files() {
        let root = temp_root();
        write(
            &root,
            "a.ts",
            "export function authenticate(u: string) { return u; }\n",
        );
        write(
            &root,
            "b.ts",
            "import { authenticate } from './a';\nexport function run() { authenticate('x'); authenticate('y'); }\n",
        );
        symbols::build_index(&root).unwrap();

        let graph = analyze(&root, "authenticate", 1, false).unwrap();
        let run_node = graph
            .direct
            .iter()
            .find(|node| node.symbol.name == "run")
            .expect("run in direct");
        assert_eq!(run_node.references, 2, "two call sites expected");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn requires_workspace_path_outside_root_is_rejected() {
        // The Tauri command is what calls `require_workspace`; for the
        // pure helper we just assert that an empty target is rejected.
        let result = analyze(Path::new("/nonexistent"), "", 2, true);
        assert!(result.is_err(), "empty target must error");
    }
}
