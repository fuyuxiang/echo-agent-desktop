//! Validation for non-streaming model connection probes. HTTP success alone
//! does not prove inference: gateways can return errors or login pages as 200.

use serde_json::Value;

/// A connection probe must leave room for reasoning before the short answer.
/// The HTTP timeout and bounded response reader remain independent limits.
pub(crate) fn inference_probe_payload(backend: &str, model_id: &str) -> Value {
    match backend {
        "responses" => serde_json::json!({
            "model": model_id,
            "input": "Reply with OK.",
            "max_output_tokens": 1024,
            "stream": false,
        }),
        "messages" => serde_json::json!({
            "model": model_id,
            "max_tokens": 64,
            "messages": [{ "role": "user", "content": "Reply with OK." }],
            "stream": false,
        }),
        _ => serde_json::json!({
            "model": model_id,
            "messages": [{ "role": "user", "content": "Reply with OK." }],
            "stream": false,
        }),
    }
}

pub(crate) fn error_detail(body: &[u8], key: &str, truncated: bool, limit: usize) -> String {
    // Never reflect unstructured/truncated upstream bodies into the webview.
    // Parsing first also decodes JSON-escaped credentials before redaction.
    if truncated {
        return String::new();
    }
    let Ok(json) = serde_json::from_slice::<Value>(body) else {
        return String::new();
    };
    let message = json
        .pointer("/error/message")
        .or_else(|| json.get("message"))
        .or_else(|| json.get("error"))
        .or_else(|| json.pointer("/base_resp/status_msg"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut message = message.to_string();
    if !key.is_empty() {
        message = message.replace(key, "[REDACTED]");
        if let Ok(escaped) = serde_json::to_string(key) {
            message = message.replace(&escaped[1..escaped.len() - 1], "[REDACTED]");
        }
    }
    let mut snippet: String = message.chars().take(limit).collect();
    if message.chars().count() > limit {
        snippet.push('…');
    }
    snippet
}

fn text(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|s| !s.trim().is_empty())
}

fn content(value: Option<&Value>) -> bool {
    text(value)
        || value
            .and_then(Value::as_array)
            .is_some_and(|parts| parts.iter().any(|part| text(part.get("text"))))
}

fn completed_reasoning_probe(json: &Value) -> bool {
    // A real Responses model may spend the entire probe budget on reasoning.
    // Require protocol, terminal reason, reasoning item and consistent usage;
    // an empty/error-shaped HTTP 200 must still fail the connection test.
    json.get("object").and_then(Value::as_str) == Some("response")
        && json.get("status").and_then(Value::as_str) == Some("incomplete")
        && json
            .pointer("/incomplete_details/reason")
            .and_then(Value::as_str)
            == Some("max_output_tokens")
        && text(json.get("id"))
        && text(json.get("model"))
        && json
            .get("output")
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items.iter().any(|item| {
                    item.get("type").and_then(Value::as_str) == Some("reasoning")
                        && text(item.get("id"))
                })
            })
        && json
            .pointer("/usage/output_tokens_details/reasoning_tokens")
            .and_then(Value::as_u64)
            .is_some_and(|reasoning| {
                reasoning > 0
                    && json
                        .pointer("/usage/output_tokens")
                        .and_then(Value::as_u64)
                        .is_some_and(|output| output >= reasoning)
            })
}

pub(crate) fn validate_inference(body: &[u8], backend: &str, key: &str) -> Result<(), String> {
    let json: Value = serde_json::from_slice(body)
        .map_err(|_| "模型接口未返回有效 JSON 推理响应，请检查 Base URL 和接口协议".to_string())?;
    if json.get("error").is_some_and(|error| !error.is_null())
        || json
            .pointer("/base_resp/status_code")
            .and_then(Value::as_i64)
            .is_some_and(|code| code != 0)
        || matches!(
            json.get("status").and_then(Value::as_str),
            Some("failed" | "cancelled")
        )
    {
        let detail = error_detail(body, key, false, 300);
        return Err(if detail.is_empty() {
            "模型接口返回错误响应".into()
        } else {
            format!("模型接口返回错误响应：{detail}")
        });
    }
    let has_output = match backend {
        "messages" => {
            json.get("type").and_then(Value::as_str) == Some("message")
                && content(json.get("content"))
        }
        "responses" => {
            text(json.get("output_text"))
                || json
                    .get("output")
                    .and_then(Value::as_array)
                    .is_some_and(|items| items.iter().any(|item| content(item.get("content"))))
                || completed_reasoning_probe(&json)
        }
        _ => json
            .get("choices")
            .and_then(Value::as_array)
            .is_some_and(|choices| {
                choices.iter().any(|choice| {
                    let message = choice.get("message");
                    content(message.and_then(|m| m.get("content")))
                        || text(message.and_then(|m| m.get("reasoning_content")))
                        || text(message.and_then(|m| m.get("refusal")))
                })
            }),
    };
    if has_output {
        Ok(())
    } else {
        Err("模型响应缺少有效推理输出，请检查 Model ID 和接口协议".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_http_success_without_inference() {
        for body in [
            r#"{"error":{"message":"quota exceeded"}}"#,
            "<html>Login required</html>",
            "",
            "{}",
            r#"{"data":[]}"#,
            r#"{"choices":[]}"#,
            r#"{"choices":[{"message":{"content":""}}]}"#,
            r#"{"base_resp":{"status_code":1004,"status_msg":"bad key"}}"#,
        ] {
            assert!(
                validate_inference(body.as_bytes(), "chat_completions", "").is_err(),
                "{body}"
            );
        }
    }

    #[test]
    fn accepts_real_protocol_outputs() {
        for (backend, body) in [
            (
                "chat_completions",
                json!({"choices":[{"message":{"role":"assistant","content":"OK"}}]}),
            ),
            (
                "chat_completions",
                json!({"choices":[{"message":{"content":null,"reasoning_content":"thinking"}}]}),
            ),
            (
                "messages",
                json!({"type":"message","role":"assistant","content":[{"type":"text","text":"OK"}]}),
            ),
            (
                "responses",
                json!({"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"OK"}]}]}),
            ),
        ] {
            assert!(validate_inference(&serde_json::to_vec(&body).unwrap(), backend, "").is_ok());
        }
    }

    #[test]
    fn rejects_wrong_protocol_and_failed_responses() {
        assert!(validate_inference(
            br#"{"choices":[{"message":{"content":"OK"}}]}"#,
            "messages",
            ""
        )
        .is_err());
        assert!(validate_inference(
            br#"{"status":"failed","output_text":"partial"}"#,
            "responses",
            ""
        )
        .is_err());
    }

    fn reasoning_only_response() -> Value {
        json!({
            "id":"resp_probe", "object":"response", "model":"reasoning-model",
            "status":"incomplete", "error":null,
            "incomplete_details":{"reason":"max_output_tokens"},
            "output":[{"id":"rs_probe", "type":"reasoning", "summary":[]}],
            "usage":{"output_tokens":1024,"output_tokens_details":{"reasoning_tokens":1024}},
        })
    }

    #[test]
    fn a_reasoning_only_budget_exhaustion_proves_real_inference() {
        let body = serde_json::to_vec(&reasoning_only_response()).unwrap();
        assert!(validate_inference(&body, "responses", "").is_ok());
        assert!(validate_inference(&body, "chat_completions", "").is_err());
        assert!(validate_inference(&body, "messages", "").is_err());
    }

    #[test]
    fn incomplete_responses_without_reasoning_evidence_are_not_accepted() {
        for (pointer, replacement) in [
            ("/status", json!("failed")),
            ("/status", json!("in_progress")),
            ("/incomplete_details/reason", json!("content_filter")),
            ("/usage/output_tokens_details/reasoning_tokens", json!(0)),
            ("/usage/output_tokens_details/reasoning_tokens", json!(1025)),
            ("/usage/output_tokens", json!(null)),
            ("/output", json!([])),
            ("/output/0/type", json!("message")),
            ("/object", json!("other")),
            ("/model", json!("")),
            ("/id", json!(null)),
            ("/error", json!({"message":"bad key"})),
        ] {
            let mut response = reasoning_only_response();
            *response.pointer_mut(pointer).unwrap() = replacement;
            assert!(
                validate_inference(&serde_json::to_vec(&response).unwrap(), "responses", "")
                    .is_err(),
                "{pointer}"
            );
        }
    }

    #[test]
    fn probe_payloads_allow_a_short_answer_after_reasoning() {
        let responses = inference_probe_payload("responses", "reasoning-model");
        assert_eq!(responses["model"], "reasoning-model");
        assert_eq!(responses["stream"], false);
        assert_eq!(responses["max_output_tokens"], 1024);
        let messages = inference_probe_payload("messages", "message-model");
        assert_eq!(messages["max_tokens"], 64);
        assert_eq!(messages["stream"], false);
        let chat = inference_probe_payload("chat_completions", "chat-model");
        assert_eq!(chat["messages"][0]["content"], "Reply with OK.");
        assert!(chat.get("max_tokens").is_none());
    }

    #[test]
    fn redacts_credentials_before_truncation_and_after_json_decoding() {
        for key in [
            "echo-qa-synthetic-secret",
            "synthetic-\"quoted\"\\中文-secret",
        ] {
            let body = serde_json::to_vec(
                &json!({"error":{"message":format!("{} rejected {key}", "x".repeat(195))}}),
            )
            .unwrap();
            let detail = error_detail(&body, key, false, 220);
            assert!(!detail.contains(key));
            assert!(detail.contains("[REDACTED]"));
            let error = validate_inference(&body, "chat_completions", key).unwrap_err();
            assert!(!error.contains(key));
        }
        let escaped = br#"{"error":{"message":"bad \u0073\u0065\u0063\u0072\u0065\u0074"}}"#;
        assert_eq!(
            error_detail(escaped, "secret", false, 300),
            "bad [REDACTED]"
        );
    }

    #[test]
    fn never_reflects_malformed_or_truncated_bodies() {
        for (body, truncated) in [
            (b"<html>secret</html>".as_slice(), false),
            (br#"{"error":{"message":"secret"}}"#.as_slice(), true),
        ] {
            assert!(error_detail(body, "secret", truncated, 300).is_empty());
        }
    }
}
