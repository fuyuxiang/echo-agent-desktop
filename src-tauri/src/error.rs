//! Typed application error surfaced over the IPC boundary.
//!
//! Replaces the historical `Result<T, String>` shape. The wire format keeps
//! the human-readable `message` for backwards compatibility (the renderer
//! surfaces it through `friendlyError`) and adds a stable `code` + `kind` so the
//! frontend can branch on the failure class without string matching.
//!
//! See settings-review-report.md S-B1 and CODE_REVIEW_FINAL_REPORT.md S-B1.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Stable error categories. Each `code` belongs to exactly one `kind` so the
/// renderer can show grouped recovery actions (e.g. "Reconnect" for
/// `Kind::Network`, "Open keychain" for `Kind::Credential`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// Invalid input from the renderer (validation, schema, parse).
    Validation,
    /// Backend state precondition not met (missing config, locked resource).
    State,
    /// External dependency failed: model API, MCP server, marketplace.
    Network,
    /// Filesystem failure: read/write/delete/canonicalize.
    Filesystem,
    /// Permission denied by policy / capability.
    Permission,
    /// Credential store failure (Keychain / DPAPI / libsecret).
    Credential,
    /// Operation timed out.
    Timeout,
    /// User explicitly cancelled (interactive prompt, plan approval).
    Cancelled,
    /// Coding verification token reused, expired, or never issued.
    VerificationToken,
    /// Internal invariant broken; not user-recoverable.
    Internal,
}

impl fmt::Display for ErrorKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            ErrorKind::Validation => "validation",
            ErrorKind::State => "state",
            ErrorKind::Network => "network",
            ErrorKind::Filesystem => "filesystem",
            ErrorKind::Permission => "permission",
            ErrorKind::Credential => "credential",
            ErrorKind::Timeout => "timeout",
            ErrorKind::Cancelled => "cancelled",
            ErrorKind::VerificationToken => "verification_token",
            ErrorKind::Internal => "internal",
        };
        f.write_str(s)
    }
}

/// Stable per-category error code. Renderer branches on this value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ErrorCode(pub u32);

impl ErrorCode {
    // Validation
    pub const INVALID_SESSION_ID: Self = Self(1_001);
    pub const PAYLOAD_TOO_LARGE: Self = Self(1_002);
    pub const INVALID_ARGUMENT: Self = Self(1_003);
    pub const PATH_NOT_ALLOWED: Self = Self(1_004);

    // State
    pub const NOT_INITIALIZED: Self = Self(2_001);
    pub const ALREADY_RUNNING: Self = Self(2_002);
    pub const SESSION_NOT_FOUND: Self = Self(2_003);

    // Network
    pub const UPSTREAM_TIMEOUT: Self = Self(3_001);
    pub const UPSTREAM_UNREACHABLE: Self = Self(3_002);
    pub const UPSTREAM_RATE_LIMITED: Self = Self(3_003);
    pub const UPSTREAM_AUTH: Self = Self(3_004);

    // Filesystem
    pub const FS_READ: Self = Self(4_001);
    pub const FS_WRITE: Self = Self(4_002);
    pub const FS_NOT_FOUND: Self = Self(4_003);

    // Permission
    pub const POLICY_DENIED: Self = Self(5_001);
    pub const CAPABILITY_DENIED: Self = Self(5_002);

    // Credential
    pub const KEYCHAIN_UNAVAILABLE: Self = Self(6_001);
    pub const CREDENTIAL_NOT_FOUND: Self = Self(6_002);

    // Timeout
    pub const OPERATION_TIMEOUT: Self = Self(7_001);

    // Cancelled
    pub const USER_CANCELLED: Self = Self(8_001);

    // Verification token
    pub const TOKEN_INVALID: Self = Self(9_001);
    pub const TOKEN_EXPIRED: Self = Self(9_002);
    pub const TOKEN_ALREADY_USED: Self = Self(9_003);

    // Internal
    pub const INTERNAL: Self = Self(99_001);
}

/// The single error type used at every IPC boundary going forward.
///
/// Construct via the typed constructors (e.g. `AppError::payload_too_large`)
/// so the `kind` matches the `code` by construction — no `From<String>` that
/// would silently demote typed errors back to opaque strings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: ErrorCode,
    pub kind: ErrorKind,
    pub message: String,
}

impl AppError {
    /// Convenience: tie `code` and `kind` together so they can never drift.
    pub const fn new(code: ErrorCode, kind: ErrorKind, message: String) -> Self {
        Self { code, kind, message }
    }

    pub fn payload_too_large(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::PAYLOAD_TOO_LARGE, ErrorKind::Validation, message.into())
    }

    pub fn invalid_session_id(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::INVALID_SESSION_ID, ErrorKind::Validation, message.into())
    }

    pub fn invalid_argument(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::INVALID_ARGUMENT, ErrorKind::Validation, message.into())
    }

    pub fn path_not_allowed(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::PATH_NOT_ALLOWED, ErrorKind::Validation, message.into())
    }

    pub fn not_initialized(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NOT_INITIALIZED, ErrorKind::State, message.into())
    }

    pub fn already_running(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::ALREADY_RUNNING, ErrorKind::State, message.into())
    }

    pub fn session_not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::SESSION_NOT_FOUND, ErrorKind::State, message.into())
    }

    pub fn upstream_timeout(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::UPSTREAM_TIMEOUT, ErrorKind::Network, message.into())
    }

    pub fn upstream_unreachable(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::UPSTREAM_UNREACHABLE, ErrorKind::Network, message.into())
    }

    pub fn upstream_rate_limited(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::UPSTREAM_RATE_LIMITED, ErrorKind::Network, message.into())
    }

    pub fn upstream_auth(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::UPSTREAM_AUTH, ErrorKind::Network, message.into())
    }

    pub fn fs_read(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::FS_READ, ErrorKind::Filesystem, message.into())
    }

    pub fn fs_write(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::FS_WRITE, ErrorKind::Filesystem, message.into())
    }

    pub fn fs_not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::FS_NOT_FOUND, ErrorKind::Filesystem, message.into())
    }

    pub fn policy_denied(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::POLICY_DENIED, ErrorKind::Permission, message.into())
    }

    pub fn capability_denied(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::CAPABILITY_DENIED, ErrorKind::Permission, message.into())
    }

    pub fn keychain_unavailable(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::KEYCHAIN_UNAVAILABLE, ErrorKind::Credential, message.into())
    }

    pub fn credential_not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::CREDENTIAL_NOT_FOUND, ErrorKind::Credential, message.into())
    }

    pub fn operation_timeout(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::OPERATION_TIMEOUT, ErrorKind::Timeout, message.into())
    }

    pub fn user_cancelled(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::USER_CANCELLED, ErrorKind::Cancelled, message.into())
    }

    pub fn token_invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::TOKEN_INVALID, ErrorKind::VerificationToken, message.into())
    }

    pub fn token_expired(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::TOKEN_EXPIRED, ErrorKind::VerificationToken, message.into())
    }

    pub fn token_already_used(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::TOKEN_ALREADY_USED, ErrorKind::VerificationToken, message.into())
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::INTERNAL, ErrorKind::Internal, message.into())
    }

    /// Whether the renderer should offer a retry action.
    pub fn is_retryable(&self) -> bool {
        matches!(self.kind, ErrorKind::Network | ErrorKind::Timeout | ErrorKind::Filesystem)
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}:{}] {}", self.kind, self.code.0, self.message)
    }
}

impl std::error::Error for AppError {}

// -----------------------------------------------------------------------
// IPC boundary serialization.
//
// Historically every `#[tauri::command]` returned `Result<T, String>` and the
// renderer consumed `String` directly. To avoid a 250+ file churn we expose a
// `serde` shape that ALSO serializes correctly when the renderer still
// expects a flat `String`: the `app_error::WireEnvelope` keeps `message` at
// the top level (so existing `friendlyError(String(e))` keeps working) and
// nests the typed fields for new callers that opt into the structured form.
// -----------------------------------------------------------------------

pub mod wire {
    use super::{AppError, ErrorCode, ErrorKind};
    use serde::{Deserialize, Serialize};

    /// Wire shape sent across the IPC boundary. The flat `message` is the
    /// backwards-compat field; `kind` and `code` are the new structured fields.
    #[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "camelCase")]
    pub struct WireEnvelope {
        pub message: String,
        pub kind: ErrorKind,
        pub code: ErrorCode,
    }

    impl From<AppError> for WireEnvelope {
        fn from(err: AppError) -> Self {
            Self { message: err.message, kind: err.kind, code: err.code }
        }
    }

    impl From<WireEnvelope> for AppError {
        fn from(env: WireEnvelope) -> Self {
            AppError { message: env.message, kind: env.kind, code: env.code }
        }
    }

    /// String fallback when a downstream crate still emits `String` errors.
    /// Promoted to `Internal` because the caller gave up its error type.
    impl From<String> for AppError {
        fn from(value: String) -> Self {
            AppError::internal(value)
        }
    }

    impl From<&str> for AppError {
        fn from(value: &str) -> Self {
            AppError::internal(value)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_constructors_bind_code_to_kind() {
        let err = AppError::payload_too_large("oops");
        assert_eq!(err.kind, ErrorKind::Validation);
        assert_eq!(err.code, ErrorCode::PAYLOAD_TOO_LARGE);
    }

    #[test]
    fn network_errors_are_retryable_filesystem_errors_too() {
        assert!(AppError::upstream_timeout("a").is_retryable());
        assert!(AppError::upstream_unreachable("a").is_retryable());
        assert!(AppError::upstream_rate_limited("a").is_retryable());
        assert!(AppError::operation_timeout("a").is_retryable());
        assert!(AppError::fs_read("a").is_retryable());
        assert!(AppError::fs_write("a").is_retryable());
    }

    #[test]
    fn validation_state_and_credential_errors_are_not_retryable() {
        assert!(!AppError::payload_too_large("a").is_retryable());
        assert!(!AppError::not_initialized("a").is_retryable());
        assert!(!AppError::session_not_found("a").is_retryable());
        assert!(!AppError::keychain_unavailable("a").is_retryable());
        assert!(!AppError::credential_not_found("a").is_retryable());
        assert!(!AppError::policy_denied("a").is_retryable());
    }

    #[test]
    fn cancelled_and_token_errors_are_not_retryable() {
        assert!(!AppError::user_cancelled("a").is_retryable());
        assert!(!AppError::token_expired("a").is_retryable());
        assert!(!AppError::token_invalid("a").is_retryable());
        assert!(!AppError::token_already_used("a").is_retryable());
    }

    #[test]
    fn wire_envelope_round_trips() {
        let err = AppError::upstream_rate_limited("rate");
        let env: wire::WireEnvelope = err.clone().into();
        let json = serde_json::to_string(&env).unwrap();
        // backwards-compat: renderer that only reads `message` keeps working
        assert!(json.contains("\"message\":\"rate\""));
        assert!(json.contains("\"kind\":\"network\""));
        assert!(json.contains("\"code\":3003"));
        let back: AppError = serde_json::from_str(&json).unwrap();
        assert_eq!(back, err);
    }

    #[test]
    fn string_fallback_is_internal() {
        let err: AppError = String::from("legacy").into();
        assert_eq!(err.kind, ErrorKind::Internal);
        assert_eq!(err.code, ErrorCode::INTERNAL);
        assert_eq!(err.message, "legacy");
    }

    #[test]
    fn display_includes_kind_code_and_message() {
        let err = AppError::fs_not_found("/nope");
        let s = format!("{err}");
        assert!(s.contains("filesystem"));
        assert!(s.contains("4003"));
        assert!(s.contains("/nope"));
    }
}
