//! Generic helper for calling EchoAgent `echo.agent/*` ACP extension methods.
//!
//! EchoAgent exposes Skills, MCP, and session-admin operations as extension
//! methods (see `xai-grok-shell/src/extensions/`). All of them go through the
//! same wire shape — `acp::ExtRequest { method, params: RawValue }` →
//! `acp::ExtResponse(Arc<RawValue>)`. This module centralizes the send/parse
//! so each feature module only has to declare its method + params + return type.

use std::sync::Arc;

use agent_client_protocol as acp;
use anyhow::{anyhow, Result};
use serde::de::DeserializeOwned;
use serde_json::value::RawValue;
use xai_acp_lib::{acp_send, AcpAgentTx};

/// Build a `RawValue` from a serializable value. Used to construct the `params`
/// payload for an ext request.
pub fn raw_params<T: serde::Serialize>(value: &T) -> Arc<RawValue> {
    // `to_raw_value` only fails for fundamentally un-serializable values (e.g.
    // maps with non-string keys); for our typed params this is infallible in
    // practice, so we unwrap.
    serde_json::value::to_raw_value(value)
        .expect("ext params serialization is infallible for typed inputs")
        .into()
}

/// Call a EchoAgent extension method (e.g. `echo.agent/skills/list`) and return the
/// parsed response. Errors from the agent (method_not_found, invalid_request,
/// …) surface as `Err(anyhow!(...))` — callers decide whether to treat that
/// as fatal or fall back to an empty default.
pub async fn call_ext<T: DeserializeOwned>(
    tx: &AcpAgentTx,
    method: &str,
    params: Arc<RawValue>,
) -> Result<T> {
    let resp = call_ext_value(tx, method, params).await?;
    parse_ext_response(&resp).map_err(|e| anyhow!("ext {method}: parse response: {e}"))
}

/// Like [`call_ext`] but returns the raw `ExtResponse` without decoding.
/// Useful when the caller just needs a yes/no success signal (rename, delete,
/// toggle, …) and doesn't care about the (usually `{ "success": true }`) body.
pub async fn call_ext_value(
    tx: &AcpAgentTx,
    method: &str,
    params: Arc<RawValue>,
) -> Result<acp::ExtResponse> {
    let req = acp::ExtRequest::new(method, params);
    let resp: acp::ExtResponse = acp_send(req, tx)
        .await
        .map_err(|e| anyhow!("ext {method}: {e:?}"))?;
    Ok(resp)
}

/// Best-effort parse of an `ExtResponse` into a typed value. The response body
/// is a `RawValue` (arbitrary JSON from the agent); failures are mapped to a
/// plain `anyhow::Error` rather than panicking.
pub fn parse_ext_response<T: DeserializeOwned>(resp: &acp::ExtResponse) -> Result<T> {
    let raw_str = resp.0.get();
    let value: serde_json::Value =
        serde_json::from_str(raw_str).map_err(|e| anyhow!("decode ext response JSON: {e}"))?;

    // Current EchoAgent extension methods use ExtMethodResult's wire envelope:
    // `{ "result": T | null, "error"?: string | object }`. Older builds and
    // a few raw extension endpoints return T directly, so preserve that shape
    // as a fallback. Envelope detection must happen before decoding T: loose
    // response types with defaulted fields can otherwise accept the envelope
    // object and silently produce an empty result (MCP used to do exactly that).
    if let Some(object) = value.as_object() {
        if let Some(result) = object.get("result") {
            let error = object.get("error").filter(|error| !error.is_null());
            if result.is_null() {
                if let Some(error) = error {
                    return Err(anyhow!(
                        "extension returned error: {}",
                        format_ext_error(error)
                    ));
                }
            }
            return serde_json::from_value(result.clone())
                .map_err(|e| anyhow!("decode ext response result: {e}"));
        }
    }

    serde_json::from_value(value).map_err(|e| anyhow!("decode ext response: {e}"))
}

fn format_ext_error(error: &serde_json::Value) -> String {
    if let Some(message) = error.as_str() {
        return message.to_string();
    }
    if let Some(message) = error.get("message").and_then(serde_json::Value::as_str) {
        return message.to_string();
    }
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Deserialize, PartialEq)]
    struct ListPayload {
        items: Vec<String>,
    }

    fn response(value: serde_json::Value) -> acp::ExtResponse {
        acp::ExtResponse::new(raw_params(&value))
    }

    #[test]
    fn parses_current_result_envelope() {
        let parsed: ListPayload = parse_ext_response(&response(serde_json::json!({
            "result": { "items": ["one", "two"] }
        })))
        .unwrap();

        assert_eq!(parsed.items, vec!["one", "two"]);
    }

    #[test]
    fn preserves_legacy_raw_response_compatibility() {
        let parsed: ListPayload = parse_ext_response(&response(serde_json::json!({
            "items": ["legacy"]
        })))
        .unwrap();

        assert_eq!(parsed.items, vec!["legacy"]);
    }

    #[test]
    fn surfaces_enveloped_extension_error() {
        let error = parse_ext_response::<ListPayload>(&response(serde_json::json!({
            "result": null,
            "error": { "code": "invalid", "message": "bad request" }
        })))
        .unwrap_err();

        assert!(error.to_string().contains("bad request"));
    }
}
