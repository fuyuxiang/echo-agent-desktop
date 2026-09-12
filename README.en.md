<p align="center">
  <img src="app-icon.png" width="96" height="96" alt="EchoAgent logo" />
</p>

<h1 align="center">EchoAgent</h1>

<p align="center">
  <strong>More than answers—give AI a real workspace and let it finish the job.</strong>
  <br />
  EchoAgent is an open-source, local-first desktop agent workspace. Connect the models you choose, let them understand projects, edit files, and use tools within explicit permissions, then review every deliverable.
</p>

<p align="center">
  <a href="README.md">中文</a>
  · <a href="#quick-start">Quick start</a>
  · <a href="#capabilities">Capabilities</a>
  · <a href="#how-it-works">How it works</a>
  · <a href="#data-and-security-boundaries">Security</a>
  · <a href="https://github.com/fuyuxiang/echo-agent-desktop/issues">Issues</a>
</p>

<p align="center">
  <a href="https://github.com/fuyuxiang/echo-agent-desktop/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/fuyuxiang/echo-agent-desktop/ci.yml?branch=main&style=flat-square&label=CI" alt="CI status" /></a>
  <a href="https://github.com/fuyuxiang/echo-agent-desktop/stargazers"><img src="https://img.shields.io/github/stars/fuyuxiang/echo-agent-desktop?style=flat-square" alt="GitHub stars" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square" alt="MIT license" /></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-2563eb?style=flat-square" alt="Windows and macOS" />
  <img src="https://img.shields.io/badge/built%20with-Tauri%202-24c8db?style=flat-square&logo=tauri&logoColor=white" alt="Built with Tauri 2" />
</p>

<p align="center">
  <img src="docs/images/echoagent-home.png" alt="EchoAgent desktop home with workspace, model, and permission controls" width="100%" />
</p>

<p align="center"><sub>One place to choose a workspace, model, and permission mode—then describe the outcome you want.</sub></p>

## From one goal to a reviewable deliverable

Real work rarely ends with one answer. It requires context, planning, tools, feedback, and a clear record of what changed. EchoAgent is designed around that entire loop instead of treating it as an add-on to chat.

| Principle | EchoAgent's design choice |
| --- | --- |
| **Workspace-native** | Sessions bind to real directories, keeping files, previews, search, changes, and artifacts in one context |
| **Transparent execution** | Plans, streaming output, tool calls, permission requests, and unified diffs stay visible and interruptible |
| **Models and capabilities stay modular** | Bring your own keys and combine models, MCP servers, skills, plugins, experts, and sub-agents as needed |
| **Built for ongoing collaboration** | Projects, memory, knowledge sources, and automation preserve context beyond a single conversation |

<p align="center">
  <strong>Goal → Context → Plan → Tool use → Approval → File changes → Deliverable</strong>
</p>

While a task runs, you can edit the plan, approve or reject sensitive actions, cancel execution, and rewind or fork from earlier points. The model moves the work forward; you retain control.

## Quick start

The repository includes the embedded Agent Runtime and pinned source snapshots of its dependencies. A normal clone is enough—no Git submodule initialization is required.

<details>
<summary><strong>Prerequisites</strong></summary>

| Dependency | Requirement |
| --- | --- |
| Node.js | 20 or newer; CI uses Node.js 22 |
| pnpm | 10; the expected version is pinned in the repository |
| Rust | Stable, minimum `1.92.0`, with `rustfmt` and `clippy` |
| Protocol Buffers | A native `protoc` on `PATH`, or a `PROTOC` environment variable |
| Platform toolchain | macOS: Xcode Command Line Tools. Windows: VS 2022 Build Tools with Desktop development with C++ and a Windows SDK |

</details>

### macOS

```bash
git clone https://github.com/fuyuxiang/echo-agent-desktop.git
cd echo-agent-desktop

pnpm setup:mac
pnpm install --frozen-lockfile
pnpm tauri dev
```

### Windows (PowerShell)

```powershell
git clone https://github.com/fuyuxiang/echo-agent-desktop.git
cd echo-agent-desktop

pnpm setup:win
pnpm install --frozen-lockfile
.\dev.bat
```

The first build compiles the complete Rust Runtime and takes longer than later incremental builds.

### Connect your first model

1. Start EchoAgent and open **Settings → Model**.
2. Choose a provider and enter your API key. Custom services also need an endpoint and protocol.
3. Add at least one model and optionally test the connection.
4. Return home, select a workspace, model, and permission mode, then send your first task.

<details>
<summary><strong>Configure with TOML</strong></summary>

The settings UI writes to `~/.echo-agent/config.toml`. This is a minimal OpenAI-compatible example:

```toml
[models]
default = "your-model-id"

[model_providers.my-provider]
base_url = "https://your-endpoint.example/v1"
api_key = "YOUR_API_KEY"
api_backend = "chat_completions"
auth_scheme = "bearer"
context_window = 128000

[model.your-model-id]
model_provider = "my-provider"
name = "My Model"
```

Restart EchoAgent after editing the file manually. The settings UI is recommended for everyday use because it validates fields and preserves unrelated configuration.

</details>

## Capabilities

| Area | Capabilities |
| --- | --- |
| **Agent execution** | Streaming sessions, editable plans, slash commands, cancellation, rewind and fork, live sub-agent status, and teams |
| **Workspace** | Directory-scoped sessions, full-text search, file trees, common-document previews, change tracking, unified diffs, and deliverable assets |
| **Models** | OpenAI, Anthropic, DeepSeek, and Qwen presets; multiple providers and models; OpenAI- and Anthropic-compatible endpoints |
| **Extensions** | MCP over stdio/HTTP, MCP OAuth, skills, plugins, connector catalogs, reusable experts, and local capability marketplaces |
| **Long-term context** | Project instructions, tasks and plans, personal memory, session summaries, local-folder knowledge sources, and an optional organization service |
| **Automation and delivery** | One-time or recurring schedules, run history, task-level permissions, desktop notifications, Slack, Discord, webhooks, and WebDAV |
| **Content experience** | File and image attachments, drag and drop, voice input, GFM, syntax highlighting, KaTeX, Mermaid, and tool-result previews |

## How it works

EchoAgent is not a web wrapper around a command-line tool. The Agent Runtime runs inside the desktop process and communicates with the Tauri host over typed ACP channels. Rust owns session state, policy, scheduling, and native capabilities; React provides the interactive task surface.

```mermaid
flowchart TB
    UI[React 18 UI<br/>Sessions · Projects · Settings · Workspace] <-->|Tauri Commands / Events| HOST[Tauri 2 + Rust host<br/>Storage · Policy · Scheduler · Native APIs]
    HOST <-->|Typed ACP channels| RUNTIME[In-process Agent Runtime<br/>Sessions · Plans · Tools · Permissions · Sub-agents]
    RUNTIME --> MODELS[Model providers<br/>OpenAI · Anthropic · Compatible]
    RUNTIME --> TOOLS[Local files and commands<br/>MCP · Skills · Plugins]
    HOST --> DATA[(Local data root<br/>.echo-agent)]
    HOST --> EXT[WebDAV · Notifications · Optional organization service]
```

The core Runtime comes from [**`echo-agent`**](https://github.com/fuyuxiang/echo-agent). Its entry crate is `echo-agent-runtime`, with a pinned source snapshot under `vendor/echo-agent-build/`. It runs on a dedicated OS thread backed by a current-thread Tokio Runtime and `LocalSet`; the bridge converts streaming updates, permission requests, and plan state into Tauri events routed to the correct session.

```text
src/                       React UI, Zustand stores, and frontend domain logic
src-tauri/src/             Tauri commands, ACP bridge, policy, storage, scheduler
vendor/echo-agent-build/   Pinned source snapshot of the embedded Agent Runtime
vendor/async-openai/       Pinned OpenAI-compatible Rust client source
vendor/nucleo/             Pinned fuzzy-matching library source
scripts/                   Setup, verification, build, and release scripts
docs/                      Platform build and desktop-update documentation
```

## Data and security boundaries

EchoAgent stores application state under `~/.echo-agent/` by default. Set `ECHO_AGENT_HOME` before launch to use another data root. Folder trust, task permission modes, and allow/ask/deny rules work together to govern tool execution.

| Data | Default location |
| --- | --- |
| Model, permission, and runtime configuration | `~/.echo-agent/config.toml` |
| MCP configuration | `~/.echo-agent/mcp.json` |
| Sessions and workspace history | `~/.echo-agent/sessions/` |
| Agents, skills, and memory | `~/.echo-agent/agents/`, `~/.echo-agent/skills/`, `~/.echo-agent/memory/` |
| Expert, connector, and built-in skill catalogs | `~/.echo-agent/experts-marketplace/`, `~/.echo-agent/connectors-marketplace/`, `~/.echo-agent/resources/builtin-skills/` |

- Provider API keys are currently stored in the local `config.toml`. EchoAgent tightens file permissions on Unix; Windows protection depends on the current user's ACL. Never commit this file or attach it to a public issue.
- “Local-first” describes application state and execution control, not full offline operation. Model, MCP, WebDAV, notification, and optional organization features contact their configured services.
- Memory is enabled by default. The current Runtime uses preset SiliconFlow endpoints for `BAAI/bge-m3` embeddings and `BAAI/bge-reranker-v2-m3` reranking. Review the relevant configuration before handling sensitive content, or disable memory under **Settings → Memory**.
- For untrusted repositories, use Approval mode, grant only the required directories, and inspect risky actions individually.

## Development and verification

| Command | Purpose |
| --- | --- |
| `pnpm tauri dev` | Run the complete desktop application |
| `pnpm dev` | Start only the Vite frontend; native capabilities require the Tauri container |
| `pnpm test` | Run frontend Vitest tests |
| `pnpm build` | Type-check TypeScript and build the frontend |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib -j 2` | Run Rust unit tests |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | Check Rust formatting |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` | Run Clippy |

CI runs frontend type checking, unit tests, the production build, Rust formatting, Clippy, and Rust unit tests for pushes to `main` and pull requests.

## Roadmap

- Smoother Windows and macOS release, installation, and update flows
- Linux platform adaptation and distribution
- Officially maintained connector, skill, and plugin catalogs
- Desktop end-to-end tests and visual regression coverage
- Broader user documentation and UI internationalization

The roadmap communicates direction rather than delivery commitments. Follow the [issue tracker](https://github.com/fuyuxiang/echo-agent-desktop/issues) for current priorities.

## FAQ

<details>
<summary><strong>Can I use a local model?</strong></summary>

Yes. Any local service exposing an OpenAI- or Anthropic-compatible HTTP API can be added as a custom provider. Tool calling and multimodal support still depend on the specific model and service.

</details>

<details>
<summary><strong>Do I need an EchoAgent account?</strong></summary>

Not for personal use. Models use your own credentials and primary state remains local. Organization features are an optional external-service integration.

</details>

<details>
<summary><strong>Does EchoAgent support Linux?</strong></summary>

Linux adaptation is in progress. The frontend and most Rust modules are portable; remaining work centers on file dialogs, system notifications, packaging, and platform verification.

</details>

## Contributing

Contributions are welcome across bug fixes, tests, documentation, UI improvements, provider/MCP compatibility, and Runtime capabilities.

1. Fork the repository and create a branch focused on one issue from `main`.
2. Add relevant tests and documentation for behavior changes.
3. Run the frontend or Rust checks related to your change.
4. Open a pull request describing motivation, implementation, risk, and verification.

For larger features or architecture changes, open an issue first to discuss UX, compatibility, and security boundaries.

## Acknowledgements

EchoAgent is built with [Tauri](https://tauri.app/), [React](https://react.dev/), and [Vite](https://vite.dev/). The embedded Agent Runtime is maintained as a pinned source snapshot; provenance, compatibility changes, and third-party licenses are recorded in [Third-Party Notices](THIRD_PARTY_NOTICES.md).

## License

EchoAgent application code is released under the [MIT License](LICENSE). Vendored components and other third-party dependencies remain under their respective licenses; see [Third-Party Notices](THIRD_PARTY_NOTICES.md).
