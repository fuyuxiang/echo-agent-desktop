//! Deterministic safety gates for documentation-only Agent tasks.
//!
//! The language model is responsible for prose quality; this module enforces
//! the non-negotiable part locally: a request that only asks for comments or
//! documentation must not silently alter executable source code. Markdown and
//! other documentation artifacts are allowed, while source files are compared
//! after comments and insignificant whitespace are removed.

use std::path::Path;

use crate::coding::changeset::{self, ChangeKind, ChangeSet};
use crate::coding::task::CodingTask;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocumentationViolation {
    pub file: Option<String>,
    pub message: String,
}

fn contains_clause(requirement: &str, phrase: &str) -> bool {
    requirement.match_indices(phrase).any(|(index, _)| {
        requirement[index + phrase.len()..]
            .chars()
            .next()
            .map_or(true, |next| {
                next.is_whitespace() || "，。；、,.!?！？：:)）]】".contains(next)
            })
    })
}

fn latest_requirement(task: &CodingTask) -> &str {
    task.acceptance_criteria
        .iter()
        .rev()
        // Structured-plan acceptance rows describe implementation checks, not
        // a newer user instruction. They must never disable a documentation
        // safety constraint established by the original request or follow-up.
        .find(|criterion| !criterion.id.contains(":acceptance:"))
        .map(|criterion| criterion.content.as_str())
        .unwrap_or(task.requirement.as_str())
}

fn contains_documentation_noun(value: &str) -> bool {
    [
        "注释",
        "说明",
        "文档",
        "jsdoc",
        "docstring",
        "rustdoc",
        "comment",
        "documentation",
        "readme",
        "docs/",
    ]
    .iter()
    .any(|needle| value.contains(needle))
}

fn contains_mutation_verb(value: &str) -> bool {
    [
        "修复",
        "解决",
        "实现",
        "新增",
        "开发",
        "重构",
        "改造",
        "优化",
        "迁移",
        "升级",
        "接入",
        "集成",
        "搭建",
        "构建",
        "修改",
        "删除",
        "移除",
        "清除",
        "更新",
        "完善",
        "增加",
        "添加",
        "fix",
        "solve",
        "implement",
        "build",
        "develop",
        "refactor",
        "migrate",
        "upgrade",
        "integrate",
        "change",
        "modify",
        "add",
        "remove",
        "delete",
        "update",
        "optimize",
    ]
    .iter()
    .any(|needle| value.contains(needle))
}

/// Distinguish a pure documentation edit from either a product feature about
/// documentation or a combined implementation + comments request.
fn contains_implementation_work(requirement: &str) -> bool {
    let documentation_capability = contains_documentation_noun(requirement)
        && [
            "功能",
            "能力",
            "入口",
            "产品",
            "工作流",
            "feature",
            "capability",
            "workflow",
        ]
        .iter()
        .any(|needle| requirement.contains(needle))
        && contains_mutation_verb(requirement);
    if documentation_capability {
        return true;
    }

    let mut clauses = requirement.to_string();
    for separator in [
        "并且", "同时", "以及", "然后", "之后", "后再", " and ", " then ",
    ] {
        clauses = clauses.replace(separator, "\n");
    }
    clauses
        .split(|character| matches!(character, '\n' | '，' | ',' | '；' | ';' | '并' | '和'))
        .any(|clause| contains_mutation_verb(clause) && !contains_documentation_noun(clause))
}

pub fn is_read_only_task(task: &CodingTask) -> bool {
    let requirement = latest_requirement(task).to_lowercase();
    let explicit = requirement.contains("只做分析")
        || requirement.contains("只读分析")
        || requirement.contains("仅做解释")
        || requirement.contains("只解释")
        || requirement.contains("不修改任何文件")
        || requirement.contains("不修改工程文件")
        || contains_clause(&requirement, "不修改文件")
        || contains_clause(&requirement, "不要修改文件")
        || contains_clause(&requirement, "不得修改文件")
        || contains_clause(&requirement, "无需修改文件")
        || requirement.contains("read-only")
        || requirement.contains("readonly");
    let explains_code = ["解释", "说明", "梳理", "explain"]
        .iter()
        .any(|needle| requirement.contains(needle))
        && [
            "代码",
            "函数",
            "方法",
            "类",
            "模块",
            "系统",
            "架构",
            "调用链",
            "业务规则",
            "code",
            "function",
            "method",
            "class",
            "module",
            "system",
            "architecture",
        ]
        .iter()
        .any(|needle| requirement.contains(needle));
    let asks_for_mutation = [
        "修复",
        "实现",
        "新增",
        "添加",
        "增加",
        "补充",
        "完善",
        "更新",
        "编写",
        "删除",
        "移除",
        "清除",
        "重构",
        "改造",
        "fix",
        "implement",
        "add",
        "write",
        "update",
        "remove",
        "delete",
        "refactor",
    ]
    .iter()
    .any(|needle| requirement.contains(needle));
    explicit || (explains_code && !asks_for_mutation)
}

/// Limit the strict gate to tasks whose user-visible requirement is actually
/// documentation-only. Mixed requests (for example "fix the bug and document
/// it") are still verified by the ordinary build/test pipeline.
pub fn requires_comment_only_validation(task: &CodingTask) -> bool {
    let requirement = latest_requirement(task).to_lowercase();
    if is_read_only_task(task) {
        return false;
    }
    let asks_for_docs = requirement.contains("/doc")
        || requirement.contains("代码注释")
        || requirement.contains("文档注释")
        || requirement.contains("架构文档")
        || requirement.contains("模块文档")
        || requirement.contains("系统级文档")
        || requirement.contains("readme")
        || requirement.contains("documentation")
        || requirement.contains("文档化")
        || requirement.contains("jsdoc")
        || requirement.contains("docstring")
        || requirement.contains("rustdoc")
        || (requirement.contains("注释")
            && [
                "生成", "添加", "增加", "加上", "补充", "完善", "更新", "编写", "删除", "移除",
                "清除",
            ]
            .iter()
            .any(|verb| requirement.contains(verb)));
    if !asks_for_docs {
        return false;
    }
    let explicitly_comment_only = requirement.contains("不改变任何可执行逻辑")
        || requirement.contains("不改变可执行逻辑")
        || requirement.contains("只添加注释")
        || requirement.contains("仅添加注释");
    let mixed_implementation = contains_implementation_work(&requirement);
    explicitly_comment_only || !mixed_implementation
}

fn documentation_file(path: &str) -> bool {
    matches!(
        Path::new(path)
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "md" | "mdx" | "rst" | "adoc" | "txt" | "mmd" | "puml"
    )
}

fn requests_source_comments(task: &CodingTask) -> bool {
    let requirement = latest_requirement(task).to_lowercase();
    requirement.contains("代码注释")
        || requirement.contains("文档注释")
        || requirement.contains("jsdoc")
        || requirement.contains("docstring")
        || requirement.contains("rustdoc")
        || requirement.contains("source comment")
        || (requirement.contains("注释")
            && [
                "生成", "添加", "增加", "加上", "补充", "完善", "更新", "编写", "删除", "移除",
                "清除",
            ]
            .iter()
            .any(|verb| requirement.contains(verb)))
}

fn requests_document_artifact(task: &CodingTask) -> bool {
    let requirement = latest_requirement(task).to_lowercase();
    requirement.contains("架构文档")
        || requirement.contains("系统级文档")
        || requirement.contains("readme")
        || requirement.contains("markdown")
        || requirement.contains("docs/")
        || requirement.contains(".md")
}

fn source_style(
    path: &str,
) -> Option<(
    &'static [&'static str],
    &'static [(&'static str, &'static str)],
)> {
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())?
        .to_ascii_lowercase();
    match extension.as_str() {
        "ts" | "tsx" | "js" | "jsx" | "java" | "kt" | "kts" | "go" | "rs" | "c" | "h" | "cc"
        | "cpp" | "cxx" | "cs" | "swift" | "scala" | "scss" | "less" | "dart" | "proto" | "sol"
        | "jsonc" | "json5" => Some((&["//"], &[("/*", "*/")])),
        "css" => Some((&[], &[("/*", "*/")])),
        "py" | "pyi" | "rb" | "sh" | "bash" | "zsh" | "yaml" | "yml" | "toml" | "r" | "graphql"
        | "ex" | "exs" => Some((&["#"], &[])),
        "sql" | "lua" => Some((&["--"], &[("/*", "*/")])),
        "html" | "htm" | "xml" | "vue" | "svelte" | "astro" => {
            Some((&[], &[("<!--", "-->"), ("/*", "*/")]))
        }
        "php" => Some((&["//", "#"], &[("<!--", "-->"), ("/*", "*/")])),
        "fs" | "fsx" => Some((&["//"], &[("(*", "*)")])),
        "hs" => Some((&["--"], &[("{-", "-}")])),
        "erl" | "hrl" => Some((&["%"], &[])),
        "clj" | "cljs" | "cljc" => Some((&[";"], &[])),
        _ => None,
    }
}

fn starts_with(bytes: &[u8], offset: usize, marker: &str) -> bool {
    bytes
        .get(offset..offset.saturating_add(marker.len()))
        .is_some_and(|candidate| candidate == marker.as_bytes())
}

/// Remove Python module/function/class docstrings that occupy the first
/// statement position. Other triple-quoted strings are preserved as code.
fn strip_python_docstrings(source: &str) -> String {
    let mut output = String::with_capacity(source.len());
    let mut module_statement_seen = false;
    let mut definition_indent: Option<usize> = None;
    let mut expected_suite_indent: Option<usize> = None;
    let mut open_docstring: Option<&str> = None;

    for line in source.split_inclusive('\n') {
        let trimmed = line.trim_start_matches([' ', '\t']);
        let indent = line.len() - trimmed.len();

        if let Some(delimiter) = open_docstring {
            if let Some(end) = trimmed.find(delimiter) {
                let tail = &trimmed[end + delimiter.len()..];
                if !tail.trim().is_empty() {
                    output.push_str(tail);
                } else if line.ends_with('\n') {
                    output.push('\n');
                }
                open_docstring = None;
            } else if line.ends_with('\n') {
                output.push('\n');
            }
            continue;
        }

        let content = trimmed.trim_end_matches(['\r', '\n']);
        let insignificant = content.trim().is_empty() || content.trim_start().starts_with('#');
        let starts_definition = content.starts_with("def ")
            || content.starts_with("async def ")
            || content.starts_with("class ");
        if starts_definition {
            definition_indent = Some(indent);
        }
        if definition_indent.is_some() && content.trim_end().ends_with(':') {
            expected_suite_indent = definition_indent.take();
        }

        let delimiter = if content.starts_with("\"\"\"") {
            Some("\"\"\"")
        } else if content.starts_with("'''") {
            Some("'''")
        } else {
            None
        };
        let is_module_doc = !module_statement_seen && delimiter.is_some();
        let is_suite_doc = expected_suite_indent
            .is_some_and(|suite_indent| indent > suite_indent && delimiter.is_some());
        if let Some(delimiter) = delimiter.filter(|_| is_module_doc || is_suite_doc) {
            let after_open = &content[delimiter.len()..];
            if let Some(end) = after_open.find(delimiter) {
                let tail = &after_open[end + delimiter.len()..];
                if !tail.trim().is_empty() {
                    output.push_str(tail);
                    if line.ends_with('\n') {
                        output.push('\n');
                    }
                } else if line.ends_with('\n') {
                    output.push('\n');
                }
            } else {
                open_docstring = Some(delimiter);
                if line.ends_with('\n') {
                    output.push('\n');
                }
            }
            module_statement_seen = true;
            expected_suite_indent = None;
            continue;
        }

        if !insignificant {
            module_statement_seen = true;
            if expected_suite_indent.is_some_and(|suite_indent| indent > suite_indent) {
                expected_suite_indent = None;
            }
        }
        output.push_str(line);
    }
    output
}

/// Canonical executable representation for one lexical comment style.
fn canonicalize(source: &str, line_comments: &[&str], block_comments: &[(&str, &str)]) -> Vec<u8> {
    let bytes = source.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index].is_ascii_whitespace() {
            index += 1;
            continue;
        }
        if let Some(marker) = line_comments
            .iter()
            .find(|marker| starts_with(bytes, index, marker))
        {
            index += marker.len();
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if let Some((open, close)) = block_comments
            .iter()
            .find(|(open, _)| starts_with(bytes, index, open))
        {
            index += open.len();
            let mut depth = 1usize;
            while index < bytes.len() && depth > 0 {
                if open == &"/*" && starts_with(bytes, index, open) {
                    depth += 1;
                    index += open.len();
                } else if starts_with(bytes, index, close) {
                    depth -= 1;
                    index += close.len();
                } else {
                    index += 1;
                }
            }
            continue;
        }
        if matches!(bytes[index], b'\'' | b'"' | b'`') {
            let quote = bytes[index];
            output.push(quote);
            index += 1;
            while index < bytes.len() {
                output.push(bytes[index]);
                if bytes[index] == b'\\' && index + 1 < bytes.len() {
                    index += 1;
                    output.push(bytes[index]);
                } else if bytes[index] == quote {
                    index += 1;
                    break;
                }
                index += 1;
            }
            continue;
        }
        output.push(bytes[index]);
        index += 1;
    }
    output
}

fn embedded_tag_at(lower_source: &str, offset: usize) -> Option<(usize, &'static str)> {
    ["script", "style"]
        .into_iter()
        .filter_map(|tag| {
            let marker = format!("<{tag}");
            let mut search_from = offset;
            loop {
                let index = search_from + lower_source.get(search_from..)?.find(&marker)?;
                let boundary = lower_source.as_bytes().get(index + marker.len()).copied();
                if boundary.map_or(true, |byte| byte.is_ascii_whitespace() || byte == b'>') {
                    return Some((index, tag));
                }
                search_from = index + marker.len();
            }
        })
        .min_by_key(|(index, _)| *index)
}

/// Markup needs region-aware handling. Treating `//` as a comment everywhere
/// would hide changes to attributes such as `href=https://...`; only script
/// bodies use JavaScript line comments and only style bodies use CSS comments.
fn canonicalize_markup(source: &str) -> Vec<u8> {
    let lower = source.to_ascii_lowercase();
    let mut output = Vec::with_capacity(source.len());
    let mut cursor = 0usize;
    while let Some((tag_start, tag)) = embedded_tag_at(&lower, cursor) {
        let Some(open_end) = lower[tag_start..]
            .find('>')
            .map(|index| tag_start + index + 1)
        else {
            break;
        };
        output.extend(canonicalize(
            &source[cursor..open_end],
            &[],
            &[("<!--", "-->")],
        ));
        let close_marker = format!("</{tag}");
        let content_end = lower[open_end..]
            .find(&close_marker)
            .map(|index| open_end + index)
            .unwrap_or(source.len());
        if tag == "script" {
            output.extend(canonicalize(
                &source[open_end..content_end],
                &["//"],
                &[("/*", "*/")],
            ));
        } else {
            output.extend(canonicalize(
                &source[open_end..content_end],
                &[],
                &[("/*", "*/")],
            ));
        }
        cursor = content_end;
        if content_end == source.len() {
            return output;
        }
    }
    output.extend(canonicalize(&source[cursor..], &[], &[("<!--", "-->")]));
    output
}

/// Canonical executable representation: comments and whitespace outside
/// quoted strings are removed, while string bytes remain exact.
fn executable_signature(path: &str, source: &str) -> Option<Vec<u8>> {
    let (line_comments, block_comments) = source_style(path)?;
    let lower_path = path.to_ascii_lowercase();
    if [".html", ".htm", ".xml", ".vue", ".svelte", ".astro"]
        .iter()
        .any(|extension| lower_path.ends_with(extension))
    {
        return Some(canonicalize_markup(source));
    }
    let preprocessed = if lower_path.ends_with(".py") || lower_path.ends_with(".pyi") {
        strip_python_docstrings(source)
    } else {
        source.to_string()
    };
    Some(canonicalize(&preprocessed, line_comments, block_comments))
}

pub fn validate_documentation_changes(
    root: &Path,
    task: &CodingTask,
    set: &ChangeSet,
) -> Vec<DocumentationViolation> {
    if is_read_only_task(task) {
        return set
            .changes
            .iter()
            .map(|change| DocumentationViolation {
                file: Some(change.path.clone()),
                message: "只读代码解释任务不得修改、创建、删除或重命名任何工程文件".into(),
            })
            .collect();
    }
    if !requires_comment_only_validation(task) {
        return Vec::new();
    }
    let mut violations = Vec::new();
    for change in &set.changes {
        if documentation_file(&change.path) {
            continue;
        }
        if source_style(&change.path).is_none() {
            violations.push(DocumentationViolation {
                file: Some(change.path.clone()),
                message: "无法证明该文件只变更了注释：文件类型不在安全校验范围内".into(),
            });
            continue;
        }
        if change.kind != ChangeKind::Modified {
            violations.push(DocumentationViolation {
                file: Some(change.path.clone()),
                message: "纯注释任务不应新建、删除或重命名源代码文件".into(),
            });
            continue;
        }
        let Some(before) = change.baseline_content.as_deref() else {
            violations.push(DocumentationViolation {
                file: Some(change.path.clone()),
                message: "缺少任务基线，无法证明可执行逻辑未变".into(),
            });
            continue;
        };
        let current_path = match changeset::resolve_in_workspace(root, &change.path) {
            Ok(path) => path,
            Err(message) => {
                violations.push(DocumentationViolation {
                    file: Some(change.path.clone()),
                    message,
                });
                continue;
            }
        };
        let after = match std::fs::read_to_string(&current_path) {
            Ok(content) => content,
            Err(error) => {
                violations.push(DocumentationViolation {
                    file: Some(change.path.clone()),
                    message: format!("无法读取注释生成后的文件：{error}"),
                });
                continue;
            }
        };
        if executable_signature(&change.path, before) != executable_signature(&change.path, &after)
        {
            violations.push(DocumentationViolation {
                file: Some(change.path.clone()),
                message: "检测到可执行代码、字面量或公共结构发生变化；注释任务必须撤销这些逻辑改动"
                    .into(),
            });
        }
    }
    let has_source_change = set
        .changes
        .iter()
        .any(|change| !documentation_file(&change.path));
    let has_document_artifact = set
        .changes
        .iter()
        .any(|change| documentation_file(&change.path));
    if !set.changes.is_empty() && requests_source_comments(task) && !has_source_change {
        violations.push(DocumentationViolation {
            file: None,
            message: "用户要求修改源码注释，但变更集中没有任何源代码文件；不能用单独的说明文档替代代码注释"
                .into(),
        });
    }
    if !set.changes.is_empty() && requests_document_artifact(task) && !has_document_artifact {
        violations.push(DocumentationViolation {
            file: None,
            message: "用户要求生成架构/系统文档，但变更集中没有可审阅的文档文件".into(),
        });
    }
    violations
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_comments_do_not_change_the_executable_signature() {
        let before = "export function total(a: number) { return a + 1; }\n";
        let after = "/** Return the adjusted total. */\nexport function total(a: number) {\n  // Keep the historical offset.\n  return a + 1;\n}\n";
        assert_eq!(
            executable_signature("total.ts", before),
            executable_signature("total.ts", after)
        );
    }

    #[test]
    fn executable_and_string_changes_are_detected() {
        assert_ne!(
            executable_signature("total.ts", "const url = \"http://a\"; return 1;"),
            executable_signature("total.ts", "const url = \"http://b\"; return 2;")
        );
    }

    #[test]
    fn python_docstrings_and_hash_comments_are_documentation() {
        let before = "def total(value):\n    return value + 1\n";
        let after = "def total(value):\n    \"\"\"Return the adjusted total.\"\"\"\n    # Historical offset.\n    return value + 1\n";
        assert_eq!(
            executable_signature("total.py", before),
            executable_signature("total.py", after)
        );
    }

    #[test]
    fn html_embedded_css_and_javascript_comments_are_documentation() {
        let before = "<style>body { color: red; }</style>\n<script>const total = 1;</script>\n";
        let after = "<!-- Page shell. -->\n<style>/* Preserve brand color. */ body { color: red; }</style>\n<script>// Stable public value.\nconst total = 1;</script>\n";
        assert_eq!(
            executable_signature("index.html", before),
            executable_signature("index.html", after)
        );
    }

    #[test]
    fn markup_urls_remain_executable_evidence() {
        let before = "<a href=https://example.com/old>Open</a>\n";
        let after = "<!-- External destination. --><a href=https://example.com/new>Open</a>\n";
        assert_ne!(
            executable_signature("index.html", before),
            executable_signature("index.html", after)
        );
    }
}
