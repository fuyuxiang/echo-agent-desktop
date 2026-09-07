//! Pure text-classification helpers shared by the sibling [`crate::flush`]
//! and [`crate::dream`] response-processing modules.
//!
//! Keeping these helpers separate lets both memory domains depend on
//! `text_utils` without depending on each other.

/// Check if text contains at least one markdown header (`#` or `##`).
///
/// Used by both flush and dream response processing to ensure the model
/// produced structured output.
pub fn has_markdown_headers(text: &str) -> bool {
    text.lines().any(|line| {
        let line = line.trim_start();
        let hashes = line.bytes().take_while(|byte| *byte == b'#').count();
        (1..=6).contains(&hashes) && line.as_bytes().get(hashes) == Some(&b' ')
    })
}

/// Remove provider reasoning envelopes before model output is persisted.
///
/// Some OpenAI-compatible gateways serialize hidden reasoning as literal
/// `<think>...</think>` text. Persisting that text leaks implementation detail
/// into memory and can also make a trailing `NO_REPLY` look like valid markdown.
/// An unterminated reasoning block is discarded through the end of the response:
/// incomplete hidden reasoning is never useful durable memory.
pub fn strip_reasoning_blocks(text: &str) -> String {
    const TAGS: [(&str, &str); 3] = [
        ("<think>", "</think>"),
        ("<thinking>", "</thinking>"),
        ("<reasoning>", "</reasoning>"),
    ];

    let lower = text.to_ascii_lowercase();
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0;

    while cursor < text.len() {
        let next = TAGS
            .iter()
            .filter_map(|(open, close)| {
                lower[cursor..]
                    .find(open)
                    .map(|offset| (cursor + offset, *open, *close))
            })
            .min_by_key(|(start, _, _)| *start);

        let Some((start, open, close)) = next else {
            output.push_str(&text[cursor..]);
            break;
        };
        output.push_str(&text[cursor..start]);
        let content_start = start + open.len();
        let Some(close_offset) = lower[content_start..].find(close) else {
            break;
        };
        cursor = content_start + close_offset + close.len();
    }

    output
}

/// Check if the response matches the NO_REPLY convention.
///
/// Strips all non-alphanumeric characters, lowercases, and checks if the
/// remainder is exactly `"noreply"`. This handles common separator variants:
/// `"no reply"`, `"no_reply"`, `"no-reply"`, `"NO REPLY"`, etc.
pub fn is_no_reply(text: &str) -> bool {
    let normalized: String = text
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect();
    normalized == "noreply"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_no_reply() {
        assert!(is_no_reply("NO_REPLY"));
        assert!(is_no_reply("no reply"));
        assert!(is_no_reply("No-Reply"));
        assert!(is_no_reply("noreply"));
        assert!(!is_no_reply("no reply needed"));
        assert!(!is_no_reply("I have things to store"));
    }

    #[test]
    fn test_has_markdown_headers() {
        assert!(has_markdown_headers("## Topic"));
        assert!(has_markdown_headers("# Title\n\nBody"));
        assert!(has_markdown_headers("preamble\n\n## Topic"));
        assert!(!has_markdown_headers("plain text without headers"));
        assert!(!has_markdown_headers("#hashtag without space"));
        assert!(!has_markdown_headers("inline ## heading-like text"));
    }

    #[test]
    fn test_strip_reasoning_blocks() {
        assert_eq!(
            strip_reasoning_blocks("<think>private ## notes</think>\n## Useful\nFact"),
            "\n## Useful\nFact"
        );
        assert_eq!(
            strip_reasoning_blocks("before<THINK>hidden</THINK>after"),
            "beforeafter"
        );
        assert_eq!(strip_reasoning_blocks("<thinking>unfinished"), "");
        assert_eq!(strip_reasoning_blocks("## untouched"), "## untouched");
    }
}
