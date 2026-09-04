<p align="center">
  <img src="app-icon.png" width="112" height="112" alt="EchoAgent logo" />
</p>

<h1 align="center">EchoAgent</h1>

<p align="center">
  <strong>An open-source desktop workspace for autonomous AI agents.</strong>
  <br />
  Bring your own model, connect MCP tools, and run agent workflows from a fast native shell.
</p>

<p align="center">
  <a href="README.md">中文</a>
  · <a href="#overview">Overview</a>
  · <a href="#features">Features</a>
  · <a href="#quick-start">Quick start</a>
  · <a href="#architecture">Architecture</a>
  · <a href="#development">Development</a>
  · <a href="#roadmap">Roadmap</a>
</p>

<p align="center">
  <a href="https://github.com/fuyuxiang/echo-agent-desktop/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/fuyuxiang/echo-agent-desktop/ci.yml?branch=main&style=flat-square&label=CI" alt="CI status" /></a>
  <a href="https://github.com/fuyuxiang/echo-agent-desktop/stargazers"><img src="https://img.shields.io/github/stars/fuyuxiang/echo-agent-desktop?style=flat-square" alt="GitHub stars" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square" alt="MIT license" /></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-2563eb?style=flat-square" alt="Windows and macOS" />
  <img src="https://img.shields.io/badge/Tauri-2-24c8db?style=flat-square&logo=tauri&logoColor=white" alt="Tauri 2" />
  <img src="https://img.shields.io/badge/Rust-1.92%2B-dea584?style=flat-square&logo=rust&logoColor=white" alt="Rust 1.92 or newer" />
</p>

<p align="center">
  <img src="src/assets/landing-hero.png" alt="EchoAgent — people and an AI agent working together" width="100%" />
</p>

## Overview

EchoAgent turns model APIs into a practical desktop agent workspace. It combines conversations, files, tools, permissions, plans, sub-agents, and scheduled work in one application—without requiring an EchoAgent cloud account.

The core agent runtime is embedded directly in the Tauri process and communicates with the React interface through [Agent Client Protocol (ACP)](https://agentclientprotocol.com/). Streaming output, tool calls, approval requests, plan changes, and task lifecycle events therefore share one typed execution path.

> [!IMPORTANT]
> EchoAgent is pre-1.0 software under active development. Windows and macOS source builds are supported; packaged builds are currently unsigned. Review every permission request before allowing an agent to execute commands or modify files.

### Design principles

| Principle | What it means in EchoAgent |
| --- | --- |
| **Provider-independent** | Use OpenAI, Anthropic, DeepSeek, Qwen, or a compatible custom endpoint with your own credentials. |
| **Workspace-native** | Sessions are attached to real directories, with file context, changes, artifacts, and searchable local history. |
| **Extensible by default** | Add capabilities through MCP servers, skills, reusable assistants, and sub-agent teams. |
| **Explicitly controlled** | Folder trust, permission modes, allow/ask/deny rules, and visible tool calls keep execution inspectable. |
| **Native and efficient** | Tauri, Rust, and the system webview provide a lightweight desktop shell around an in-process runtime. |

## Features

| Area | Capabilities |
| --- | --- |
| **Agent workflows** | Streaming conversations, editable plans, rewind and fork, prompt history, slash commands, live sub-agent tasks, cancellation, and team status. |
| **Models** | Multiple provider profiles, multiple models per provider, context-window configuration, model discovery, and custom OpenAI- or Anthropic-compatible endpoints. |
| **Tools and extensions** | MCP over stdio or HTTP, MCP OAuth flows, skills, plugins, reusable assistants, and local catalogs. |
| **Workspace** | Directory-scoped sessions, pinning and archiving, full-text session search, file tree, previews, change tracking, and unified diffs. |
| **Rich content** | Image attachments, drag and drop, native voice input, syntax highlighting, GitHub Flavored Markdown, KaTeX, Mermaid, and tool-result images. |
| **Knowledge and memory** | Persisted memory management, local-folder knowledge sources, reusable project context, and assistant definitions. |
| **Automation** | One-time and recurring local schedules, execution history, connector selection, and per-automation permission modes. |
| **Integrations** | WebDAV storage plus desktop, Slack, Discord, and generic webhook notifications. |
| **Notification inbox** | The agent mail panel aggregates permission requests, folder-trust prompts, task updates, plan-mode switches, MCP status, session completion, and other lifecycle events; entries can be browsed, filtered, marked read, or cleared. |
| **Safety and policy** | Inline approvals, folder trust, permission rules, configurable execution modes, and policy controls for models and features. |

## Quick start

### Packaged builds

When a packaged build is available, download it from [GitHub Releases](https://github.com/fuyuxiang/echo-agent-desktop/releases). EchoAgent can produce a Windows NSIS installer and a macOS DMG.

> [!WARNING]
> Current packages are not code-signed or notarized. Only install artifacts from a release you trust and verify the release notes before running them.

### Build from source

#### Prerequisites

| Dependency | Requirement |
| --- | --- |
| Rust | Stable toolchain, Rust 1.92 or newer. `rust-toolchain.toml` installs `rustfmt` and `clippy`. |
| Node.js | Node.js 20 or newer; CI uses Node.js 22. |
| pnpm | pnpm 10. The repository pins the expected package-manager version in `package.json`. |
| Protocol Buffers | A native `protoc` executable available on `PATH`, or through the `PROTOC` environment variable. |
| Platform toolchain | macOS: Xcode Command Line Tools. Windows: Visual Studio 2022 Build Tools with **Desktop development with C++** and a Windows SDK. |

The embedded runtime is checked in as regular source under `vendor/grok-build/` and versioned atomically with the desktop application. Compatibility changes and the EchoAgent protocol namespace migration are integrated directly into that source, while the pinned `async-openai` and `nucleo` sources are also maintained under `vendor/`. A normal clone needs no submodule initialization and does not download source from those three Git repositories during a build. The setup script only verifies the integrity of the vendored source.

**macOS**

```bash
git clone https://github.com/fuyuxiang/echo-agent-desktop.git
cd echo-agent-desktop

pnpm setup:mac
pnpm install --frozen-lockfile
pnpm tauri dev
```

**Windows (PowerShell)**

```powershell
git clone https://github.com/fuyuxiang/echo-agent-desktop.git
cd echo-agent-desktop

pnpm setup:win
pnpm install --frozen-lockfile
.\dev.bat
```

The first build compiles the complete embedded Rust runtime and may take several minutes and substantial disk space. Incremental builds are considerably faster. See [Windows build notes](docs/WINDOWS_BUILD_NOTES.md) for MSVC, `protoc`, and environment troubleshooting.

### Configure your first model

1. Start EchoAgent and open **Settings → Models**.
2. Add a provider and enter its API key and endpoint.
3. Add at least one model under that provider.
4. Select the model in the composer and start a task.

Built-in presets are available for Anthropic, OpenAI, DeepSeek, and Qwen. Custom OpenAI-compatible and Anthropic-compatible endpoints are also supported.

<details>
<summary><strong>Manual configuration</strong></summary>

The UI writes provider configuration to `~/.echo-agent/config.toml`. A minimal OpenAI-compatible configuration looks like this:

```toml
[models]
default = "gpt-4o"

[model_providers.openai]
base_url = "https://api.openai.com/v1"
api_key = "YOUR_API_KEY"
api_backend = "chat_completions"
auth_scheme = "bearer"
context_window = 128000

[model.gpt-4o]
model_provider = "openai"
name = "GPT-4o"
```

Restart EchoAgent after editing the file by hand. The settings UI is recommended because it validates provider fields and preserves unrelated configuration.

</details>

## Data and security

EchoAgent keeps its application state under `~/.echo-agent/` by default. Set `ECHO_AGENT_HOME` before launch to use a different directory.

| Data | Default location |
| --- | --- |
| Providers, permissions, UI defaults, MCP configuration | `~/.echo-agent/config.toml` and `~/.echo-agent/mcp.json` |
| Conversations and workspace history | `~/.echo-agent/sessions/` |
| Reusable assistants | `~/.echo-agent/agents/` |
| Installed skills | `~/.echo-agent/skills/` |
| Expert marketplace | `~/.echo-agent/experts-marketplace/` |
| Connector marketplace and its skills | `~/.echo-agent/connectors-marketplace/` |
| Built-in skill resources | `~/.echo-agent/resources/builtin-skills/` |
| Memory and runtime state | `~/.echo-agent/memory/` and EchoAgent-owned JSON files |

Every path in this table is rooted at `ECHO_AGENT_HOME`; `~/.echo-agent` is only the default when that variable is unset. The Experts, Skills, and Connectors panels persist only sources selected manually. Automatically discovered defaults always follow the active data home.

New tasks without an explicit directory use `EchoAgent Workspace` inside the system Documents directory by default (falling back to a same-named subdirectory of the user home when Documents is unavailable). EchoAgent does not grant the entire user home by default. To use another workspace or local knowledge source, grant it explicitly through the native directory picker.

- API keys and endpoint credentials are stored locally in plaintext. On Unix, EchoAgent applies owner-only permissions to secret-bearing files and directories; on Windows, access depends on the current user's filesystem ACLs.
- Model, MCP, WebDAV, and notification traffic is sent only to services you configure. No hosted EchoAgent account is required.
- Tool execution may read files, modify files, or run commands. Use permission rules and restricted modes for repositories or data you do not fully trust.
- Never commit `~/.echo-agent/config.toml`, copied credentials, or runtime state to version control.

### Data migration

On first launch, EchoAgent performs a one-time import from the legacy `~/.grok/` data directory: files or subdirectories missing under `~/.echo-agent/` are copied over, except for the retired `auth.json`, and a `.legacy-data-migrated` marker is written so the import never runs again. Existing files in `~/.echo-agent/` always win — the migration never overwrites them — and the legacy directory is left in place for rollback.

The expert marketplace is also safely imported from the historical `~/EchoAgent/agents/` or `~/agents/` location into `experts-marketplace/` under the active data home. When `ECHO_AGENT_HOME` is customized, the connector marketplace and built-in skills under the old default data home follow the same rule. Each import is assembled in a staging directory and atomically moved into place; an existing target always wins and the legacy source is never deleted.

When both `ECHO_AGENT_HOME` and `GROK_HOME` are set, the migration source follows `GROK_HOME`; the embedded runtime is also rewired at startup to use the `ECHO_AGENT_HOME` path so subsequent writes never land in the legacy location.

## Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│ React 18 interface                                          │
│ components · Zustand stores · Markdown · workspace views    │
└──────────────────────┬──────────────────────────────────────┘
                       │ Tauri commands and events
┌──────────────────────▼──────────────────────────────────────┐
│ Tauri 2 / Rust application layer                            │
│ commands · bridge · sessions · providers · policy · storage │
└──────────────────────┬──────────────────────────────────────┘
                       │ typed ACP messages over mpsc channels
┌──────────────────────▼──────────────────────────────────────┐
│ In-process agent runtime                                    │
│ session lifecycle · tools · plans · permissions · sub-agents│
└──────────────┬──────────────────┬───────────────────────────┘
               │                  │
       Model providers        MCP servers / local tools
```

The runtime runs on a dedicated OS thread with a current-thread Tokio runtime and `LocalSet`. The Rust bridge translates ACP updates into Tauri events such as `agent://update`, `agent://permission`, and `agent://complete`; the frontend stores apply those events to the active session.

### Repository layout

```text
src/
├── components/             React views and feature panels
├── foundation/             Shared icons and UI primitives
├── lib/                    ACP client, domain logic, and utilities
├── stores/                 Zustand application stores
└── styles/                 Design tokens and application styles

src-tauri/
├── src/agent_runtime.rs     Embedded runtime lifecycle
├── src/bridge.rs            ACP-to-Tauri event bridge
├── src/commands.rs          Session command surface
├── src/lib.rs               Tauri setup and command registration
└── src/*.rs                 Providers, MCP, skills, policy, storage, and more

vendor/grok-build/           Apache-2.0 Runtime source maintained in this repository
vendor/async-openai/         Vendored OpenAI-compatible Rust client source
vendor/nucleo/               Vendored fuzzy-matching Rust source
scripts/                     Setup and packaging scripts
docs/                        Platform-specific documentation
.github/workflows/           Continuous integration
```

## Development

### Commands

| Command | Purpose |
| --- | --- |
| `pnpm tauri dev` | Run the complete desktop application in development mode. |
| `pnpm dev` | Run the Vite frontend only. Tauri APIs are unavailable in a normal browser. |
| `pnpm test` | Run the Vitest frontend test suite. |
| `pnpm build` | Type-check TypeScript and create the production frontend bundle. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib` | Run Rust unit tests. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored spawn_smoke` | Run the opt-in embedded-runtime smoke test. |
| `pnpm dist:mac` | Build an unsigned DMG on macOS. |
| `pnpm dist:win` | Build an unsigned NSIS installer on Windows. |

CI runs TypeScript type-checking, frontend unit tests, the production frontend build, and Rust formatting, Clippy, and unit-test checks on every pull request. Running focused tests locally before pushing is still recommended for faster feedback.

### Contributing

Contributions are welcome, from focused fixes to new runtime capabilities.

1. Fork and clone the repository normally; the embedded Runtime is already included.
2. Create a branch from `main`.
3. Add tests for behavioral changes and run the relevant checks above.
4. Keep changes scoped and update documentation when behavior changes.
5. Open a pull request with the motivation, implementation notes, and verification results.

For substantial features or architecture changes, open an issue first so the design and compatibility impact can be discussed before implementation.

## Roadmap

- Linux development support and distributable packages
- Signed and notarized Windows/macOS releases
- Automated release publishing and artifact checksums
- A first-party connector and skill catalog
- End-to-end desktop tests and visual-regression coverage
- Expanded user documentation and interface localization

Roadmap items are directional rather than release commitments. Follow the [issue tracker](https://github.com/fuyuxiang/echo-agent-desktop/issues) for current priorities.

## FAQ

<details>
<summary><strong>Can I use a local model?</strong></summary>

Yes, when the local server exposes a compatible OpenAI or Anthropic API. Add it as a custom provider and point `base_url` at the local endpoint. Tool-calling and multimodal behavior depend on the model and server implementation.

</details>

<details>
<summary><strong>Does EchoAgent work on Linux?</strong></summary>

Linux packages are not currently maintained. The frontend and most of the Rust code are already portable — `tauri-plugin-autostart` and other core dependencies are enabled on macOS, Windows, and Linux simultaneously, and the build scripts and configuration layer are written with Linux in mind. File dialogs, system notifications, and the packaging pipeline still need platform-specific work, however; contributions from anyone with a Linux environment are welcome.

</details>

<details>
<summary><strong>Where are my API keys stored?</strong></summary>

Provider keys are stored in `~/.echo-agent/config.toml`. They are not placed in the repository, but they are plaintext secrets on your local disk. Protect that file and never include it in bug reports or commits.

</details>

## Acknowledgements

- [xai-org/grok-build](https://github.com/xai-org/grok-build) provides the original Apache-2.0 Runtime source; EchoAgent maintains its compatible source snapshot in this repository.
- [Tauri](https://tauri.app/), [React](https://react.dev/), and [Vite](https://vite.dev/) provide the core application stack.

EchoAgent is an independent community project. It is not affiliated with, endorsed by, or sponsored by xAI.

## License

EchoAgent application code is available under the [MIT License](LICENSE). Vendored and third-party components retain their original licenses; see [Third-Party Notices](THIRD_PARTY_NOTICES.md).
