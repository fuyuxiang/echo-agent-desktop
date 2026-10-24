//! Keep model-visible JSON below Runtime's MCP output limit. Cursors contain
//! observations only; native identity and action validation remain in Context.
use super::{identity, Value, REF_AGE};
use serde_json::json;
use std::{collections::HashMap, time::Instant};

pub(super) const MAX_OUTPUT_BYTES: usize = 12_000;
const MAX_CACHE_BYTES: usize = 4 * 1024 * 1024;

pub(super) struct Page {
    pub window_ref: Option<String>,
    pub created: Instant,
    value: Value,
    key: &'static str,
}

fn clip(value: &mut Value, key: &str, limit: usize) -> bool {
    if let Some(text) = value.get(key).and_then(Value::as_str) {
        if text.chars().count() > limit {
            value[key] = json!(text.chars().take(limit).collect::<String>());
            return true;
        }
    }
    false
}

pub(super) fn previews(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(previews),
        Value::Object(_) if value.get("role").is_some() => {
            let mut clipped = false;
            for key in ["name", "identifier", "application", "role"] {
                clipped |= clip(value, key, 256);
            }
            if clipped {
                value["metadataPreviewTruncated"] = json!(true);
            }
            if clip(value, "value", 512) {
                value["textTruncated"] = json!(true);
            }
        }
        Value::Object(object) => object.values_mut().for_each(previews),
        _ => {}
    }
}

pub(super) fn bound_read(value: &mut Value) {
    while serde_json::to_vec(value).unwrap().len() > MAX_OUTPUT_BYTES {
        let text = value["text"].as_str().unwrap();
        let count = text.chars().count() / 2;
        value["text"] = json!(text.chars().take(count).collect::<String>());
        value["truncated"] = json!(true);
        value["nextOffset"] = json!(value["offset"].as_u64().unwrap_or(0) + count as u64);
        value["continuationBlocked"] = json!(false);
    }
}

pub(super) fn start(
    method: &str,
    args: &Value,
    value: Value,
    pages: &mut HashMap<String, Page>,
) -> Result<Value, String> {
    start_with_budget(method, args, value, pages, MAX_OUTPUT_BYTES)
}

fn start_with_budget(
    method: &str,
    args: &Value,
    mut value: Value,
    pages: &mut HashMap<String, Page>,
    budget: usize,
) -> Result<Value, String> {
    let key = match method {
        "computer_list_apps" | "computer_list_windows" => "items",
        "computer_snapshot" | "computer_context" => "nodes",
        "computer_find" => "candidates",
        _ => {
            bound_action(&mut value);
            return Ok(value);
        }
    };
    value["sourceTool"] = json!(method);
    value["resultId"] = json!(identity());
    value["totalItems"] = json!(value[key].as_array().unwrap().len());
    next_with_budget(
        Page {
            window_ref: args["windowRef"].as_str().map(str::to_owned),
            created: Instant::now(),
            value,
            key,
        },
        pages,
        budget,
    )
}

pub(super) fn next(page: Page, pages: &mut HashMap<String, Page>) -> Result<Value, String> {
    next_with_budget(page, pages, MAX_OUTPUT_BYTES)
}

fn next_with_budget(
    mut page: Page,
    pages: &mut HashMap<String, Page>,
    budget: usize,
) -> Result<Value, String> {
    if page.created.elapsed() >= REF_AGE {
        return Err("stale_cursor: expired; refresh discovery".into());
    }
    let mut pending = page.value[page.key]
        .take()
        .as_array()
        .unwrap()
        .clone()
        .into_iter();
    let mut output = page.value.clone();
    output[page.key] = json!([]);
    // Reserve actual cursor and flags while sizing, including JSON escaping.
    let cursor = identity();
    output["nextCursor"] = json!(cursor);
    output["pageTruncated"] = json!(true);
    if serde_json::to_vec(&output).unwrap().len() > budget {
        return Err(
            "output_limit: native metadata exceeds delivery budget; use a scoped observation"
                .into(),
        );
    }
    let mut remaining = Vec::new();
    while let Some(item) = pending.next() {
        output[page.key].as_array_mut().unwrap().push(item);
        if serde_json::to_vec(&output).unwrap().len() > budget {
            remaining.push(output[page.key].as_array_mut().unwrap().pop().unwrap());
            remaining.extend(pending);
            break;
        }
    }
    if remaining.is_empty() {
        output["nextCursor"] = Value::Null;
        output["pageTruncated"] = json!(false);
    } else {
        if output[page.key].as_array().unwrap().is_empty() {
            return Err("output_limit: single native observation exceeds delivery budget".into());
        }
        page.value[page.key] = json!(remaining);
        let size = serde_json::to_vec(&page.value).unwrap().len();
        let cached: usize = pages
            .values()
            .map(|p| serde_json::to_vec(&p.value).unwrap().len())
            .sum();
        if pages.len() >= 32 || cached + size > MAX_CACHE_BYTES {
            return Err(
                "cursor_limit: refresh with a smaller snapshot or finish pending pages".into(),
            );
        }
        pages.insert(cursor, page);
    }
    Ok(output)
}

/// Outcome fields stay intact even if optional observations are unusually
/// large. Never let Runtime truncate a physical action's result into invalid
/// JSON, or make its caller mistake an already executed write for a failure.
fn bound_action(value: &mut Value) {
    let mut outcome = value.clone();
    if let Some(object) = outcome.as_object_mut() {
        object.remove("state");
    }
    if serde_json::to_vec(&outcome).unwrap().len() <= MAX_OUTPUT_BYTES / 2 {
        return;
    }
    for key in ["before", "after"] {
        let Some(node) = value.get_mut(key).filter(|v| v.is_object()) else {
            continue;
        };
        for field in ["name", "identifier", "application", "role"] {
            if clip(node, field, 64) {
                node["metadataPreviewTruncated"] = json!(true);
            }
        }
        if clip(node, "value", 128) {
            node["textTruncated"] = json!(true);
        }
        for field in ["actions", "observationErrors"] {
            if let Some(items) = node.get_mut(field).and_then(Value::as_array_mut) {
                let clipped = items.len() > 2
                    || items
                        .iter()
                        .any(|v| v.as_str().is_some_and(|s| s.chars().count() > 96));
                items.truncate(2);
                for item in items {
                    if let Some(s) = item.as_str() {
                        *item = json!(s.chars().take(96).collect::<String>());
                    }
                }
                if clipped {
                    node["metadataPreviewTruncated"] = json!(true);
                }
            }
        }
    }
}

pub(super) fn attach_state(
    result: &mut Value,
    args: &Value,
    mut state: Value,
    pages: &mut HashMap<String, Page>,
) {
    previews(result);
    bound_action(result);
    previews(&mut state);
    // Reserve the actual enclosing object, comma and key rather than treating
    // a 12KB state as if it were the entire action response.
    let mut envelope = result.clone();
    envelope["state"] = Value::Null;
    let overhead = serde_json::to_vec(&envelope).unwrap().len() - 4;
    let budget = MAX_OUTPUT_BYTES.saturating_sub(overhead);
    match start_with_budget("computer_context", args, state, pages, budget) {
        Ok(state) => result["state"] = state,
        Err(error) => {
            result["stateError"] = json!(error);
            result["observationContinuation"] = json!(
                "Refresh computer_context for the current application; do not replay the action."
            );
        }
    }
}
