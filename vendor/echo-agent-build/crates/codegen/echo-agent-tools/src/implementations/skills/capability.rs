//! Optional executable capability contract for a `SKILL.md` package.
//!
//! `SKILL.md` remains compatible with the open prompt-skill format. Packages
//! that also contain [`CAPABILITY_MANIFEST_FILE`] can declare deterministic
//! entrypoints, host requirements, connector/account requirements, permissions,
//! and expected artifacts. The contract is data, not an execution bypass:
//! entrypoints must still be launched through the normal Bash tool so the
//! runtime's sandbox and approval policy remain authoritative.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

pub const CAPABILITY_MANIFEST_FILE: &str = "echo.skill.json";
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const MAX_LIST_ITEMS: usize = 64;
const MAX_ACTIONS: usize = 32;
const MAX_TEXT_CHARS: usize = 512;
const MAX_TIMEOUT_SECONDS: u64 = 30 * 60;
const MAX_ARTIFACT_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillCapabilityManifest {
    pub schema_version: u32,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub runtime: Option<SkillRuntime>,
    #[serde(default)]
    pub requirements: SkillRequirements,
    #[serde(default)]
    pub permissions: SkillPermissions,
    #[serde(default)]
    pub artifacts: Vec<SkillArtifact>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillRuntime {
    pub kind: SkillRuntimeKind,
    /// Optional command override such as `uv` or `bun`. This must be a command
    /// name, never a path; package code belongs in an entrypoint.
    #[serde(default)]
    pub command: Option<String>,
    pub entrypoints: BTreeMap<String, String>,
    #[serde(default = "default_timeout_seconds")]
    pub timeout_seconds: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SkillRuntimeKind {
    Python,
    Node,
    Shell,
}

impl SkillRuntimeKind {
    fn default_command(self) -> &'static str {
        match self {
            Self::Python => "python3",
            Self::Node => "node",
            Self::Shell => {
                if cfg!(windows) {
                    "powershell"
                } else {
                    "sh"
                }
            }
        }
    }
}

fn default_timeout_seconds() -> u64 {
    120
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillRequirements {
    #[serde(default)]
    pub commands: Vec<String>,
    #[serde(default)]
    pub connectors: Vec<SkillConnectorRequirement>,
    #[serde(default)]
    pub os_permissions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillConnectorRequirement {
    pub id: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub account_required: bool,
    #[serde(default)]
    pub purpose: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillPermissions {
    #[serde(default)]
    pub filesystem: SkillFilesystemPermission,
    #[serde(default)]
    pub network: Vec<String>,
    #[serde(default)]
    pub external_actions: Vec<String>,
}

impl Default for SkillPermissions {
    fn default() -> Self {
        Self {
            filesystem: SkillFilesystemPermission::None,
            network: Vec::new(),
            external_actions: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SkillFilesystemPermission {
    #[default]
    None,
    WorkspaceRead,
    WorkspaceWrite,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillArtifact {
    pub id: String,
    /// Package-relative glob-like output pattern. Absolute paths and parent
    /// traversal are forbidden; outputs always belong to the active workspace.
    pub pattern: String,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub max_bytes: Option<u64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkillCapabilityState {
    InstructionOnly,
    Ready,
    MissingDependencies,
    ConfigurationRequired,
    Invalid,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkillCapabilityCheckStatus {
    Ready,
    Missing,
    ConfigurationRequired,
    Declared,
    Invalid,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillCapabilityCheck {
    pub kind: String,
    pub key: String,
    pub status: SkillCapabilityCheckStatus,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillCapabilityReport {
    pub declared: bool,
    pub state: SkillCapabilityState,
    pub ready: bool,
    pub capabilities: Vec<String>,
    pub checks: Vec<SkillCapabilityCheck>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest: Option<SkillCapabilityManifest>,
}

/// Connector states supplied by the host product. The portable runtime does
/// not own connector credentials, so it leaves these unknown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectorState {
    Ready,
    ConfigurationRequired,
    Missing,
}

/// Load and validate a package's optional capability manifest.
pub fn load_manifest(skill_root: &Path) -> Result<Option<SkillCapabilityManifest>, String> {
    let path = skill_root.join(CAPABILITY_MANIFEST_FILE);
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("read {CAPABILITY_MANIFEST_FILE}: {error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("{CAPABILITY_MANIFEST_FILE} must be a regular file"));
    }
    if metadata.len() > MAX_MANIFEST_BYTES {
        return Err(format!("{CAPABILITY_MANIFEST_FILE} exceeds 256 KiB"));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    let mut file = std::fs::File::open(&path)
        .map_err(|error| format!("read {CAPABILITY_MANIFEST_FILE}: {error}"))?;
    file.by_ref()
        .take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read {CAPABILITY_MANIFEST_FILE}: {error}"))?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(format!("{CAPABILITY_MANIFEST_FILE} exceeds 256 KiB"));
    }
    let manifest: SkillCapabilityManifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("invalid {CAPABILITY_MANIFEST_FILE}: {error}"))?;
    validate_manifest(skill_root, &manifest)?;
    Ok(Some(manifest))
}

/// Build a host-readiness report. `connector_states=None` means the portable
/// runtime cannot inspect product connector configuration; requirements remain
/// explicitly visible rather than being guessed as ready.
pub fn inspect_capability(
    skill_root: &Path,
    connector_states: Option<&HashMap<String, ConnectorState>>,
) -> SkillCapabilityReport {
    let manifest = match load_manifest(skill_root) {
        Ok(Some(manifest)) => manifest,
        Ok(None) => {
            return SkillCapabilityReport {
                declared: false,
                state: SkillCapabilityState::InstructionOnly,
                ready: true,
                capabilities: Vec::new(),
                checks: vec![SkillCapabilityCheck {
                    kind: "manifest".into(),
                    key: CAPABILITY_MANIFEST_FILE.into(),
                    status: SkillCapabilityCheckStatus::Declared,
                    message: "Prompt-only Skill; no deterministic runtime contract is declared"
                        .into(),
                }],
                manifest: None,
            };
        }
        Err(error) => {
            return SkillCapabilityReport {
                declared: true,
                state: SkillCapabilityState::Invalid,
                ready: false,
                capabilities: Vec::new(),
                checks: vec![SkillCapabilityCheck {
                    kind: "manifest".into(),
                    key: CAPABILITY_MANIFEST_FILE.into(),
                    status: SkillCapabilityCheckStatus::Invalid,
                    message: error,
                }],
                manifest: None,
            };
        }
    };

    let mut checks = Vec::new();
    let mut missing_dependency = false;
    let mut configuration_required = false;

    if let Some(runtime) = &manifest.runtime {
        let command = runtime
            .command
            .as_deref()
            .unwrap_or_else(|| runtime.kind.default_command());
        let present = command_available(command);
        missing_dependency |= !present;
        checks.push(SkillCapabilityCheck {
            kind: "command".into(),
            key: command.into(),
            status: if present {
                SkillCapabilityCheckStatus::Ready
            } else {
                SkillCapabilityCheckStatus::Missing
            },
            message: if present {
                format!("Runtime command `{command}` is available")
            } else {
                format!("Runtime command `{command}` was not found on PATH")
            },
        });
        for (action, entrypoint) in &runtime.entrypoints {
            checks.push(SkillCapabilityCheck {
                kind: "entrypoint".into(),
                key: action.clone(),
                status: SkillCapabilityCheckStatus::Ready,
                message: format!("Action `{action}` uses package entrypoint `{entrypoint}`"),
            });
        }
    }

    let mut seen_commands = HashSet::new();
    for command in &manifest.requirements.commands {
        if !seen_commands.insert(command.as_str()) {
            continue;
        }
        let present = command_available(command);
        missing_dependency |= !present;
        checks.push(SkillCapabilityCheck {
            kind: "command".into(),
            key: command.clone(),
            status: if present {
                SkillCapabilityCheckStatus::Ready
            } else {
                SkillCapabilityCheckStatus::Missing
            },
            message: if present {
                format!("Required command `{command}` is available")
            } else {
                format!("Required command `{command}` was not found on PATH")
            },
        });
    }

    for connector in &manifest.requirements.connectors {
        let state = match connector_states {
            Some(states) => states
                .get(&connector.id)
                .copied()
                .unwrap_or(ConnectorState::Missing),
            None => ConnectorState::ConfigurationRequired,
        };
        let (status, message) = match state {
            ConnectorState::Ready => (
                SkillCapabilityCheckStatus::Ready,
                format!("Connector `{}` is ready", connector_label(connector)),
            ),
            ConnectorState::ConfigurationRequired => {
                configuration_required = true;
                (
                    SkillCapabilityCheckStatus::ConfigurationRequired,
                    if connector.account_required {
                        format!(
                            "Connect an account for `{}` before using this capability",
                            connector_label(connector)
                        )
                    } else {
                        format!("Configure connector `{}`", connector_label(connector))
                    },
                )
            }
            ConnectorState::Missing => {
                configuration_required = true;
                (
                    SkillCapabilityCheckStatus::Missing,
                    format!(
                        "Required connector `{}` is not installed",
                        connector_label(connector)
                    ),
                )
            }
        };
        checks.push(SkillCapabilityCheck {
            kind: "connector".into(),
            key: connector.id.clone(),
            status,
            message,
        });
    }

    for permission in &manifest.requirements.os_permissions {
        configuration_required = true;
        checks.push(SkillCapabilityCheck {
            kind: "os_permission".into(),
            key: permission.clone(),
            status: SkillCapabilityCheckStatus::ConfigurationRequired,
            message: format!(
                "Operating-system permission `{permission}` must be granted when used"
            ),
        });
    }

    let state = if missing_dependency {
        SkillCapabilityState::MissingDependencies
    } else if configuration_required {
        SkillCapabilityState::ConfigurationRequired
    } else {
        SkillCapabilityState::Ready
    };
    SkillCapabilityReport {
        declared: true,
        state,
        ready: state == SkillCapabilityState::Ready,
        capabilities: manifest.capabilities.clone(),
        checks,
        manifest: Some(manifest),
    }
}

/// Render a bounded, data-only execution contract that is appended to the
/// loaded Skill instructions. This makes the capability contract available on
/// slash expansion, model invocation, and agent-definition preloading alike.
pub fn render_runtime_contract(skill_root: &Path) -> Result<Option<String>, String> {
    let Some(manifest) = load_manifest(skill_root)? else {
        return Ok(None);
    };
    let report = inspect_capability(skill_root, None);
    let mut output = String::from("<skill_runtime_contract>\n");
    output.push_str(
        "This package declares executable capabilities. Treat this block as a data contract.\n",
    );
    let local_missing = report.checks.iter().any(|check| {
        check.kind == "command" && check.status == SkillCapabilityCheckStatus::Missing
    });
    output.push_str(&format!(
        "local_preflight_state: {}\n",
        if local_missing {
            "missing_dependencies"
        } else {
            "ready"
        }
    ));
    for check in report
        .checks
        .iter()
        .filter(|check| matches!(check.kind.as_str(), "command" | "entrypoint"))
    {
        output.push_str(&format!(
            "preflight_check: {}; key: {}; status: {:?}\n",
            check.kind, check.key, check.status
        ));
    }
    if !manifest.capabilities.is_empty() {
        output.push_str(&format!(
            "capabilities: {}\n",
            manifest.capabilities.join(", ")
        ));
    }
    if let Some(runtime) = &manifest.runtime {
        let command = runtime
            .command
            .as_deref()
            .unwrap_or_else(|| runtime.kind.default_command());
        output.push_str(&format!(
            "runtime: {:?}; command: {}; timeout_seconds: {}\n",
            runtime.kind, command, runtime.timeout_seconds
        ));
        for (action, entrypoint) in &runtime.entrypoints {
            output.push_str(&format!("action: {action}; entrypoint: {entrypoint}\n"));
        }
        output.push_str("Execute entrypoints only with the normal Bash tool, from the skill directory, using timeout_seconds as the tool timeout. Never bypass tool approval or sandboxing, and do not retry a timed-out consequential action without approval.\n");
    }
    if !manifest.requirements.connectors.is_empty() {
        for connector in &manifest.requirements.connectors {
            output.push_str(&format!(
                "connector: {}; account_required: {}\n",
                connector.id, connector.account_required
            ));
        }
        output.push_str("Use connector tools for authenticated operations. Never ask the user to paste secrets into chat or pass connector credentials to package scripts.\n");
    }
    for permission in &manifest.requirements.os_permissions {
        output.push_str(&format!("required_os_permission: {permission}\n"));
    }
    output.push_str(&format!(
        "filesystem_permission: {:?}\n",
        manifest.permissions.filesystem
    ));
    if !manifest.permissions.network.is_empty() {
        output.push_str(&format!(
            "declared_network_origins: {}\n",
            manifest.permissions.network.join(", ")
        ));
    }
    if !manifest.permissions.external_actions.is_empty() {
        output.push_str(&format!(
            "external_actions: {}\n",
            manifest.permissions.external_actions.join(", ")
        ));
        output.push_str("Obtain normal tool approval before consequential external actions.\n");
    }
    for artifact in &manifest.artifacts {
        output.push_str(&format!(
            "artifact: {}; pattern: {}; required: {}{}{}\n",
            artifact.id,
            artifact.pattern,
            artifact.required,
            artifact
                .mime_type
                .as_deref()
                .map(|mime| format!("; mime_type: {mime}"))
                .unwrap_or_default(),
            artifact
                .max_bytes
                .map(|bytes| format!("; max_bytes: {bytes}"))
                .unwrap_or_default()
        ));
    }
    output.push_str("Verify every required artifact exists, is non-empty, and matches its declared constraints before reporting success.\n");
    output.push_str("</skill_runtime_contract>");
    Ok(Some(output))
}

/// Append the optional runtime contract without changing prompt-only Skills.
pub fn append_runtime_contract(content: String, skill_path: &Path) -> Result<String, String> {
    let Some(root) = skill_path.parent() else {
        return Ok(content);
    };
    match render_runtime_contract(root)? {
        Some(contract) if content.is_empty() => Ok(contract),
        Some(contract) => Ok(format!("{content}\n\n{contract}")),
        None => Ok(content),
    }
}

fn connector_label(connector: &SkillConnectorRequirement) -> &str {
    connector.label.as_deref().unwrap_or(&connector.id)
}

fn validate_manifest(root: &Path, manifest: &SkillCapabilityManifest) -> Result<(), String> {
    if manifest.schema_version != 1 {
        return Err(format!(
            "unsupported {CAPABILITY_MANIFEST_FILE} schemaVersion {}; expected 1",
            manifest.schema_version
        ));
    }
    validate_unique_ids("capability", &manifest.capabilities, false)?;
    if manifest.capabilities.is_empty() {
        return Err("capability manifest must declare at least one capability".into());
    }
    if manifest.runtime.is_none() && manifest.requirements.connectors.is_empty() {
        return Err(
            "capability manifest must declare a runtime or a connector implementation".into(),
        );
    }
    if let Some(runtime) = &manifest.runtime {
        if runtime.entrypoints.is_empty() || runtime.entrypoints.len() > MAX_ACTIONS {
            return Err(format!(
                "runtime entrypoints must contain 1–{MAX_ACTIONS} actions"
            ));
        }
        if !(1..=MAX_TIMEOUT_SECONDS).contains(&runtime.timeout_seconds) {
            return Err(format!(
                "runtime timeoutSeconds must be between 1 and {MAX_TIMEOUT_SECONDS}"
            ));
        }
        if let Some(command) = &runtime.command {
            validate_command(command)?;
        }
        let mut entries = HashSet::new();
        for (action, relative) in &runtime.entrypoints {
            validate_id("action", action)?;
            if !entries.insert(action.to_ascii_lowercase()) {
                return Err(format!("duplicate action `{action}`"));
            }
            let path = validate_relative_resource_path(relative, "entrypoint")?;
            let absolute = root.join(&path);
            let metadata = std::fs::symlink_metadata(&absolute)
                .map_err(|_| format!("entrypoint `{relative}` does not exist"))?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(format!("entrypoint `{relative}` must be a regular file"));
            }
            let canonical_root = root
                .canonicalize()
                .map_err(|error| format!("canonicalize skill root: {error}"))?;
            let canonical_entrypoint = absolute
                .canonicalize()
                .map_err(|error| format!("canonicalize entrypoint `{relative}`: {error}"))?;
            if !canonical_entrypoint.starts_with(&canonical_root) {
                return Err(format!("entrypoint `{relative}` escapes the Skill package"));
            }
        }
    }

    validate_unique_ids("command", &manifest.requirements.commands, true)?;
    for command in &manifest.requirements.commands {
        validate_command(command)?;
    }
    if manifest.requirements.connectors.len() > MAX_LIST_ITEMS {
        return Err(format!(
            "connector requirements exceed {MAX_LIST_ITEMS} items"
        ));
    }
    let mut connectors = HashSet::new();
    for connector in &manifest.requirements.connectors {
        validate_id("connector", &connector.id)?;
        if !connectors.insert(connector.id.to_ascii_lowercase()) {
            return Err(format!("duplicate connector `{}`", connector.id));
        }
        validate_optional_text("connector label", connector.label.as_deref())?;
        validate_optional_text("connector purpose", connector.purpose.as_deref())?;
    }
    validate_unique_ids(
        "OS permission",
        &manifest.requirements.os_permissions,
        false,
    )?;
    if manifest.permissions.network.len() > MAX_LIST_ITEMS {
        return Err(format!(
            "network allowlist exceeds {MAX_LIST_ITEMS} origins"
        ));
    }
    for origin in &manifest.permissions.network {
        validate_network_origin(origin)?;
    }
    validate_unique_ids(
        "external action",
        &manifest.permissions.external_actions,
        false,
    )?;
    if manifest.artifacts.len() > MAX_LIST_ITEMS {
        return Err(format!(
            "artifact declarations exceed {MAX_LIST_ITEMS} items"
        ));
    }
    let mut artifacts = HashSet::new();
    for artifact in &manifest.artifacts {
        validate_id("artifact", &artifact.id)?;
        if !artifacts.insert(artifact.id.to_ascii_lowercase()) {
            return Err(format!("duplicate artifact `{}`", artifact.id));
        }
        validate_artifact_pattern(&artifact.pattern)?;
        if let Some(mime_type) = artifact.mime_type.as_deref() {
            validate_mime_type(mime_type)?;
        }
        if artifact
            .max_bytes
            .is_some_and(|value| value == 0 || value > MAX_ARTIFACT_BYTES)
        {
            return Err(format!(
                "artifact `{}` maxBytes must be between 1 and {MAX_ARTIFACT_BYTES}",
                artifact.id
            ));
        }
    }
    Ok(())
}

fn validate_unique_ids(label: &str, values: &[String], command: bool) -> Result<(), String> {
    if values.len() > MAX_LIST_ITEMS {
        return Err(format!("{label} list exceeds {MAX_LIST_ITEMS} items"));
    }
    let mut seen = HashSet::new();
    for value in values {
        if command {
            validate_command(value)?;
        } else {
            validate_id(label, value)?;
        }
        if !seen.insert(value.to_ascii_lowercase()) {
            return Err(format!("duplicate {label} `{value}`"));
        }
    }
    Ok(())
}

fn validate_id(label: &str, value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 100
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-' | b'_')
        })
    {
        return Err(format!(
            "{label} `{value}` must use 1–100 lowercase letters, digits, dots, dashes, or underscores"
        ));
    }
    Ok(())
}

fn validate_command(command: &str) -> Result<(), String> {
    if command.is_empty()
        || command.len() > 128
        || command.contains(['/', '\\'])
        || command.chars().any(char::is_whitespace)
        || command.chars().any(char::is_control)
    {
        return Err(format!("invalid command name `{command}`"));
    }
    Ok(())
}

fn validate_optional_text(label: &str, value: Option<&str>) -> Result<(), String> {
    if value.is_some_and(|value| {
        value.is_empty()
            || value.chars().count() > MAX_TEXT_CHARS
            || value.chars().any(char::is_control)
    }) {
        return Err(format!(
            "{label} must contain 1–{MAX_TEXT_CHARS} non-control characters"
        ));
    }
    Ok(())
}

fn validate_relative_resource_path(value: &str, label: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    let components = path.components().collect::<Vec<_>>();
    if value.is_empty()
        || value.len() > 512
        || components.is_empty()
        || components.len() > 12
        || components
            .iter()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("{label} `{value}` must be a safe relative path"));
    }
    Ok(path.to_path_buf())
}

fn validate_artifact_pattern(pattern: &str) -> Result<(), String> {
    validate_relative_resource_path(pattern, "artifact pattern").map(|_| ())
}

fn validate_mime_type(value: &str) -> Result<(), String> {
    let Some((category, subtype)) = value.split_once('/') else {
        return Err(format!("invalid artifact MIME type `{value}`"));
    };
    let valid_part = |part: &str| {
        !part.is_empty()
            && part.len() <= 127
            && part.bytes().all(|byte| {
                byte.is_ascii_alphanumeric()
                    || matches!(
                        byte,
                        b'!' | b'#' | b'$' | b'&' | b'^' | b'_' | b'.' | b'+' | b'-'
                    )
            })
    };
    if !valid_part(category) || !valid_part(subtype) || subtype.contains('/') {
        return Err(format!("invalid artifact MIME type `{value}`"));
    }
    Ok(())
}

fn validate_network_origin(value: &str) -> Result<(), String> {
    if value.len() > 2048 {
        return Err("network origin is too long".into());
    }
    let url = url::Url::parse(value).map_err(|error| format!("invalid network origin: {error}"))?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if url.host_str().is_none()
        || (url.scheme() != "https" && !(loopback && url.scheme() == "http"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err(format!(
            "network permission `{value}` must be an HTTPS origin without credentials, path, query, or fragment"
        ));
    }
    Ok(())
}

fn command_available(command: &str) -> bool {
    if command.contains(['/', '\\']) {
        return false;
    }
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    #[cfg(windows)]
    let extensions = std::env::var_os("PATHEXT")
        .map(|value| {
            value
                .to_string_lossy()
                .split(';')
                .filter(|value| !value.is_empty())
                .map(str::to_ascii_lowercase)
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| vec![".exe".into(), ".cmd".into(), ".bat".into()]);
    std::env::split_paths(&path).any(|directory| {
        let candidate = directory.join(command);
        if is_executable_file(&candidate) {
            return true;
        }
        #[cfg(windows)]
        {
            if Path::new(command).extension().is_none()
                && extensions
                    .iter()
                    .any(|extension| directory.join(format!("{command}{extension}")).is_file())
            {
                return true;
            }
        }
        false
    })
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_manifest(root: &Path, value: serde_json::Value) {
        std::fs::create_dir_all(root.join("scripts")).unwrap();
        std::fs::write(root.join("scripts/run.py"), "print('ok')").unwrap();
        std::fs::write(
            root.join(CAPABILITY_MANIFEST_FILE),
            serde_json::to_vec_pretty(&value).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn validates_and_reports_an_executable_skill() {
        let root = tempfile::tempdir().unwrap();
        write_manifest(
            root.path(),
            serde_json::json!({
                "schemaVersion": 1,
                "capabilities": ["document.docx.create"],
                "runtime": {
                    "kind": "python",
                    "entrypoints": {"create": "scripts/run.py"},
                    "timeoutSeconds": 90
                },
                "permissions": {"filesystem": "workspace-write"},
                "artifacts": [{
                    "id": "document",
                    "pattern": "output/*.docx",
                    "required": true,
                    "maxBytes": 1048576
                }]
            }),
        );
        let manifest = load_manifest(root.path()).unwrap().unwrap();
        assert_eq!(manifest.capabilities, vec!["document.docx.create"]);
        let contract = render_runtime_contract(root.path()).unwrap().unwrap();
        assert!(contract.contains("scripts/run.py"));
        assert!(contract.contains("normal Bash tool"));
        assert!(contract.contains("Verify every required artifact"));
    }

    #[test]
    fn rejects_missing_entrypoints_and_unsafe_origins() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join(CAPABILITY_MANIFEST_FILE),
            r#"{
              "schemaVersion": 1,
              "capabilities": ["weather.lookup"],
              "runtime": {"kind":"python","entrypoints":{"run":"../escape.py"}},
              "permissions": {"network":["https://user:secret@example.com/path"]}
            }"#,
        )
        .unwrap();
        assert!(
            load_manifest(root.path())
                .unwrap_err()
                .contains("safe relative path")
        );
    }

    #[test]
    fn connector_accounts_are_never_assumed_ready() {
        let root = tempfile::tempdir().unwrap();
        write_manifest(
            root.path(),
            serde_json::json!({
                "schemaVersion": 1,
                "capabilities": ["notion.page.create"],
                "requirements": {"connectors": [{
                    "id": "notion",
                    "label": "Notion",
                    "accountRequired": true
                }]}
            }),
        );
        let unknown = inspect_capability(root.path(), None);
        assert_eq!(unknown.state, SkillCapabilityState::ConfigurationRequired);
        assert!(
            unknown
                .checks
                .iter()
                .any(|check| check.message.contains("Connect an account"))
        );

        let ready = HashMap::from([("notion".into(), ConnectorState::Ready)]);
        assert_eq!(
            inspect_capability(root.path(), Some(&ready)).state,
            SkillCapabilityState::Ready
        );
    }

    #[test]
    fn missing_runtime_command_is_reported_before_execution() {
        let root = tempfile::tempdir().unwrap();
        write_manifest(
            root.path(),
            serde_json::json!({
                "schemaVersion": 1,
                "capabilities": ["document.pdf.create"],
                "runtime": {
                    "kind": "python",
                    "command": "echoagent-command-that-must-not-exist",
                    "entrypoints": {"create": "scripts/run.py"}
                }
            }),
        );

        let report = inspect_capability(root.path(), Some(&HashMap::new()));
        assert_eq!(report.state, SkillCapabilityState::MissingDependencies);
        assert!(!report.ready);
        assert!(report.checks.iter().any(|check| {
            check.kind == "command" && check.status == SkillCapabilityCheckStatus::Missing
        }));
    }

    #[test]
    fn prompt_only_skills_remain_compatible() {
        let root = tempfile::tempdir().unwrap();
        let report = inspect_capability(root.path(), None);
        assert_eq!(report.state, SkillCapabilityState::InstructionOnly);
        assert!(report.ready);
        assert!(render_runtime_contract(root.path()).unwrap().is_none());
    }
}
