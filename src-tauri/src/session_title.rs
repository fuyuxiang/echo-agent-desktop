//! Defensive cleanup for model-generated conversation titles.
//!
//! Some OpenAI-compatible reasoning models return visible `<think>` (or
//! equivalent) blocks in `assistant.content`. Session titles are user-facing,
//! so those blocks must be removed before a title is emitted or restored.

const INTERNAL_TAGS: [&str; 4] = ["think", "thinking", "reasoning", "analysis"];
const MAX_TITLE_SCALARS: usize = 100;

fn is_tag_boundary(byte: Option<u8>) -> bool {
    byte.is_some_and(|b| b == b'>' || b.is_ascii_whitespace())
}

fn find_tag(lower: &str, tag: &str, closing: bool, from: usize) -> Option<(usize, Option<usize>)> {
    let needle = if closing {
        format!("</{tag}")
    } else {
        format!("<{tag}")
    };
    let mut offset = from;
    while let Some(relative) = lower[offset..].find(&needle) {
        let start = offset + relative;
        let after_name = start + needle.len();
        if is_tag_boundary(lower.as_bytes().get(after_name).copied()) {
            let end = lower[after_name..]
                .find('>')
                .map(|relative_end| after_name + relative_end + 1);
            return Some((start, end));
        }
        offset = start + 1;
    }
    None
}

fn find_first_opening_tag(lower: &str) -> Option<(usize, &'static str, Option<usize>)> {
    INTERNAL_TAGS
        .into_iter()
        .filter_map(|tag| find_tag(lower, tag, false, 0).map(|(start, end)| (start, tag, end)))
        .min_by_key(|(start, _, _)| *start)
}

fn contains_internal_markup(raw: &str) -> bool {
    let lower = raw.to_ascii_lowercase();
    INTERNAL_TAGS.into_iter().any(|tag| {
        find_tag(&lower, tag, false, 0).is_some() || find_tag(&lower, tag, true, 0).is_some()
    })
}

fn strip_internal_blocks(raw: &str) -> String {
    let mut output = raw.to_string();
    loop {
        let lower = output.to_ascii_lowercase();
        let Some((start, tag, open_end)) = find_first_opening_tag(&lower) else {
            break;
        };
        let Some(open_end) = open_end else {
            output.truncate(start);
            break;
        };
        let lower = output.to_ascii_lowercase();
        let Some((_, Some(close_end))) = find_tag(&lower, tag, true, open_end) else {
            // An unclosed reasoning block is unsafe. Preserve any title text
            // before it, but discard the block and everything after it.
            output.truncate(start);
            break;
        };
        output.replace_range(start..close_end, "");
    }
    output
}

/// Return a safe, single-line automatic title, or `None` when the model only
/// produced reasoning/internal markup. Manual titles deliberately bypass this
/// function so user-authored angle-bracket text remains untouched.
pub(crate) fn clean_auto_title(raw: &str) -> Option<String> {
    let stripped = strip_internal_blocks(raw);
    if contains_internal_markup(&stripped) {
        return None;
    }

    let mut title = stripped.split_whitespace().collect::<Vec<_>>().join(" ");
    for label in [
        "Session title:",
        "Session Title:",
        "Title:",
        "title:",
        "标题：",
        "标题:",
    ] {
        if let Some(rest) = title.strip_prefix(label) {
            title = rest.trim_start().to_string();
            break;
        }
    }

    if title.len() >= 2 {
        let quoted = (title.starts_with('"') && title.ends_with('"'))
            || (title.starts_with('\'') && title.ends_with('\''))
            || (title.starts_with('“') && title.ends_with('”'));
        if quoted {
            let first = title.chars().next().map(char::len_utf8).unwrap_or(0);
            let last = title.chars().next_back().map(char::len_utf8).unwrap_or(0);
            title = title[first..title.len() - last].trim().to_string();
        }
    }

    if title.is_empty() {
        return None;
    }
    if title.chars().count() > MAX_TITLE_SCALARS {
        title = title.chars().take(MAX_TITLE_SCALARS).collect();
    }
    Some(title)
}

#[cfg(test)]
mod tests {
    use super::clean_auto_title;

    #[test]
    fn removes_closed_reasoning_before_title() {
        assert_eq!(
            clean_auto_title("<think>The user only greeted twice.</think>\n简短问候与任务确认")
                .as_deref(),
            Some("简短问候与任务确认")
        );
    }

    #[test]
    fn rejects_unclosed_or_reasoning_only_output() {
        assert_eq!(clean_auto_title("<think>internal reasoning"), None);
        assert_eq!(clean_auto_title("<analysis>internal</analysis>"), None);
    }

    #[test]
    fn handles_case_attributes_labels_and_quotes() {
        assert_eq!(
            clean_auto_title(
                "<THINK data-mode=\"deep\">internal</THINK> Title: \"Fix login redirect\""
            )
            .as_deref(),
            Some("Fix login redirect")
        );
    }

    #[test]
    fn rejects_orphan_internal_closing_tag() {
        assert_eq!(clean_auto_title("reasoning</think>Final title"), None);
    }
}
