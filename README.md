<p align="center">
  <img src="app-icon.png" width="140" height="140" alt="EchoAgent" />
</p>

<h1 align="center">EchoAgent</h1>

<p align="center">
  <strong>WorkBuddy, rewritten in Rust.</strong><br/>
  An open-source, cross-platform desktop agent workspace.
</p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a>
  &nbsp;·&nbsp;
  <a href="#why-echoagent">Why</a> ·
  <a href="#-features">Features</a> ·
  <a href="#-echoagent-vs-workbuddy">Compare</a> ·
  <a href="#-quick-start">Quick Start</a> ·
  <a href="#-architecture">Architecture</a> ·
  <a href="#-roadmap">Roadmap</a>
</p>

<p align="center">
  <a href="https://github.com/opensymph/EchoAgent/releases"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/opensymph/EchoAgent?style=flat-square&logo=github&color=blue"></a>
  <a href="https://github.com/opensymph/EchoAgent/actions"><img alt="Build" src="https://img.shields.io/github/actions/workflow/status/opensymph/EchoAgent/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white"></a>
  <a href="https://github.com/opensymph/EchoAgent/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/opensymph/EchoAgent?style=flat-square&logo=starship&logoColor=white&color=yellow"></a>
  <a href="https://github.com/opensymph/EchoAgent/network/members"><img alt="Forks" src="https://img.shields.io/github/forks/opensymph/EchoAgent?style=flat-square&logo=forgejo&logoColor=white&color=orange"></a>
  <br/>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue?style=flat-square&logo=windows10&logoColor=white">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-green?style=flat-square">
  <img alt="Rust" src="https://img.shields.io/badge/Rust-stable-orange?style=flat-square&logo=rust&logoColor=white">
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2-red?style=flat-square&logo=tauri&logoColor=white">
  <img alt="React" src="https://img.shields.io/badge/React-18-61dafb?style=flat-square&logo=react&logoColor=white">
</p>

---

## Why EchoAgent?

[**Tencent WorkBuddy**](https://workbuddy.tencent.com/) showed the world what a great desktop AI agent workspace should feel like — the polished UI, plan mode, skills, MCP connectors. It's a genuinely capable product. But it's **closed-source and its data path runs through Tencent's backend.**

**EchoAgent is the open answer** — the same shape of experience, rebuilt on Rust + Tauri:

- 🔓 **Open source** — MIT application code with clearly documented third-party components; no telemetry black box or vendor lock-in.
- 🦀 **Built on Rust + Tauri** — small binary, fast cold-start, real cross-platform.
- 🪶 **~14× smaller installer** — EchoAgent's Windows installer is **~34 MB**, vs **~483 MB** for WorkBuddy. Same shape of product, a fraction of the bytes.
- 💨 **~19× less RAM at runtime** — **~20 MB** vs **~374 MB** for WorkBuddy on the same machine. Leaves your actual work room to breathe.
- ⚙️ **EchoAgent Runtime, in-process** — no subprocess spawning or WebSocket relay. The agent runs on a dedicated OS thread inside the binary you double-click.
- 🌐 **Truly cross-platform** — one codebase, Windows **and** macOS.
- 🔑 **Bring Your Own Key** — point at any model provider via `~/.echo-agent/config.toml`. The file is owner-only on Unix; because it contains secrets, **never commit it to version control**.

> *"If WorkBuddy is the polished product, EchoAgent is the one you can actually read, fork, and own."*

### 🌟 Star this repo

If this project matters to you, please give it a ⭐ — it helps others discover it and keeps development moving.

<p align="center">
  <img src="https://img.shields.io/github/stars/opensymph/EchoAgent?style=social" alt="stars">
</p>

---

## ✨ Features

<table>
<tr>
<td width="50%" valign="top">

**🎨 Pixel-close WorkBuddy UI**
Ported `--wb-*` design tokens, the full 207-icon foundation set (all implemented, no stubs), and brand assets. It *looks* like WorkBuddy, because the same atoms make it up.

**⚙️ EchoAgent Runtime, in-process**
The embedded runtime is linked as Rust path dependencies. The agent runs on its own OS thread, driven by a current-thread tokio runtime + `LocalSet`. No `child_process.spawn`.

**🔌 ACP is the contract**
Streaming `SessionUpdate`s, tool calls, plan updates, permission requests — all flow over typed `mpsc` channels, surfaced as `agent://update` / `agent://permission` / `agent://complete` Tauri events.

**🖼️ Native input and multimodal attachments**
Native microphone capture streams speech to text on macOS/Windows (with a safe Web Speech fallback). PNG/JPEG/GIF/WebP attachments are sent as ACP image blocks; other files remain explicit local path references for agent tools.

</td>
<td width="50%" valign="top">

**🔑 BYOK, multi-provider**
Bring your own keys. Configure any number of model providers in `~/.echo-agent/config.toml`.

**🧩 Extensible agent surface**
- **Skills** — `x.ai/skills/*`
- **MCP connectors** — `x.ai/mcp/*`
- **Experts / Assistants** — `~/.echo-agent/agents/*.md`

**🚀 Advanced workflows**
Plan mode (toggle & view) · Rewind (rewind & fork) · sub-agent Tasks (observe & cancel) · Slash Commands · durable local Automations scheduler.

**🗂️ Persisted integrations**
Local-folder knowledge sources survive restarts. WebDAV storage supports browse/read/write/create/delete. Agent completion and permission events can reach Slack, Discord, generic webhooks, and native desktop notifications.

**📦 Cross-platform installers**
Windows (NSIS `.exe` + MSI) and macOS (`.dmg`). CI-built releases via GitHub Actions.

</td>
</tr>
</table>

---

## ⚔️ EchoAgent vs WorkBuddy

Only rows we can actually back up are listed. WorkBuddy's internals aren't public, so we don't speculate about them.

|  | **EchoAgent** | WorkBuddy |
|---|:---:|:---:|
| **License** | ✅ MIT application code; third parties separately licensed | ❌ Closed source |
| **Cost** | Free forever | Free (Tencent-hosted) |
| **Installer size** | ✅ **~34 MB** (NSIS, measured) | ⚠️ ~483 MB |
| **Runtime memory** | ✅ **~20 MB** (measured) | ⚠️ ~374 MB |
| **BYOK / any provider** | ✅ | ✅ |
| **Provider config** | ✅ Scriptable `~/.echo-agent/config.toml` (owner-only; never commit secrets) | ⚠️ GUI-only |
| **MCP connectors** | ✅ | ✅ |
| **Skills** | ✅ | ✅ (20+ built-in) |
| **Plan / Rewind** | ✅ | ✅ |
| **Windows** | ✅ | ✅ |
| **macOS** | ✅ | ✅ |
| **Linux** | 🔜 Roadmap | 🔜 |
| **Self-host / fork** | ✅ Build it yourself | ❌ |
| **Local data / offline-friendly** | ✅ Your `~/.echo-agent/`, your disk | ⚠️ Tencent-hosted backend |

> WorkBuddy is a polished, genuinely capable product — this isn't a hit piece. The point is simply: if you want the same shape of experience but **open, forkable, and provider-agnostic**, EchoAgent is the path.

---

## 📸 Screenshots

> Screenshots coming in the first stable release. Want to help? See [Contributing](#-contributing).

<!-- TODO: drop screenshots/GIFs here once captured. A hero demo GIF is the single highest-impact asset for stars. -->

---

## 🚀 Quick Start

### Option A — Download a prebuilt binary

Grab the latest installer from the **[Releases](https://github.com/opensymph/EchoAgent/releases)** page (Windows `.exe`/`.msi`, macOS `.dmg`), then:

1. Launch EchoAgent.
2. Open **Settings → Models** and configure a Provider/API key. Done.

### Option B — Build from source

```bash
git clone --recurse-submodules https://github.com/opensymph/EchoAgent.git
cd EchoAgent

# If you forgot --recurse-submodules:
bash scripts/setup.sh           # macOS / Linux
powershell -File scripts/setup.ps1   # Windows

pnpm install
pnpm tauri dev
```

<details>
<summary><b>📋 Prerequisites</b></summary>

1. **Rust 1.92+**. `rust-toolchain.toml` selects stable Rust with each platform's native host toolchain.
2. **Node 20+** and **pnpm**.
3. **protoc** on `PATH` **and** the `PROTOC` env var pointing at it (an embedded upstream build script needs it; its bundled `bin/protoc` is a DotSlash script that doesn't run on Windows).
   - Windows: `choco install protoc`, then `setx PROTOC "C:\ProgramData\chocolatey\bin\protoc.exe"`.

> The first build compiles the full embedded runtime dependency tree (rusqlite/git2 bundled C, prost/protobuf, axum, reqwest, …) — expect **5–10 minutes**. Incremental builds are fast thereafter.

For Windows-specific gotchas (MSVC workload, mirrors, patches), see **[docs/WINDOWS_BUILD_NOTES.md](docs/WINDOWS_BUILD_NOTES.md)**.

</details>

<details>
<summary><b>🏗️ Build installers</b></summary>

```bash
pnpm dist:win    # Windows: NSIS .exe + MSI (requires MSVC link.exe + Windows SDK)
pnpm dist:mac    # macOS: .dmg (host arch; unsigned / unnotarized)
```

The Apache-2.0 upstream runtime is vendored as a pinned git submodule at `vendor/grok-build`. The setup scripts initialize it; `pnpm dist:*` verifies it before building. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

</details>

---

## 🧱 Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Tauri window (webview)                                   │
│  React UI (Topbar / Sidebar / ChatView / Composer / ...)  │
│    └── Zustand stores  ←── Tauri events ──┐               │
└───────────────────────────────────────────┼──────────────┘
                                            │ invoke() / events
┌───────────────────────────────────────────┼──────────────┐
│  Tauri Rust backend (src-tauri/src)       │              │
│   commands.rs  ← Tauri commands ──────────┘              │
│   agent_runtime.rs ← in-process runtime + ACP lifecycle           │
│   bridge.rs    ← ACP → Tauri event dispatcher            │
│   sessions.rs  ← ~/.echo-agent/sessions history listing        │
└───────────────────────┬──────────────────────────────────┘
                        │ typed ACP mpsc channels
┌───────────────────────┴──────────────────────────────────┐
│  EchoAgent runtime thread (MvpAgent, !Send, LocalSet)     │
│  Embedded ACP runtime (Rust path dependencies)            │
└──────────────────────────────────────────────────────────┘
```

### Project layout

```
src/                     # React frontend
  styles/                # tokens.css / global.css / app.css
  foundation/components/Icon/   # ported from WorkBuddy (207 icons, all implemented)
  lib/                   # agent-client.ts (Tauri command wrappers) + types.ts (ACP TS mirror)
  stores/                # Zustand: session / sessions / permission / ...
  components/            # Topbar, Sidebar, HomePage, ChatView, Composer, ...

src-tauri/               # Rust backend
  src/
    lib.rs               # Tauri entry + state + command registration
    agent_runtime.rs     # runtime lifecycle + authenticate/session/prompt/cancel
    bridge.rs            # ACP→Tauri event dispatcher + permission registry
    commands.rs          # #[tauri::command] table (agent_*)
    sessions.rs          # list ~/.echo-agent/sessions for the sidebar

scripts/                 # build.ps1 (Windows) / build.sh (macOS)
docs/                    # WINDOWS_BUILD_NOTES.md — Windows build gotchas
```

---

## 🗺️ Roadmap

- [x] Core layout: Sidebar / HomePage / ChatView / Composer
- [x] In-process EchoAgent Runtime over ACP
- [x] WorkBuddy design tokens & 207-icon foundation (all implemented, zero stubs)
- [x] BYOK multi-provider config
- [x] Skills / MCP / Experts surfaces
- [x] Plan mode · Rewind · Tasks · Slash Commands · Automations
- [x] Windows (NSIS + MSI) & macOS (DMG) installers
- [x] CI release workflow (GitHub Actions)
- [x] SceneTabs
- [ ] Skill recommendation bar
- [x] Pinned sessions & workspace grouping
- [x] Permission request, mode and rule management
- [x] Search across sessions
- [x] Persisted knowledge sources & WebDAV cloud storage
- [x] Outbound notification channels & native voice input
- [ ] Linux builds
- [ ] Code signing & notarization

See the roadmap above and the GitHub issue tracker for planned work. **PRs welcome** — see below.

---

## 🤝 Contributing

EchoAgent is early and moving fast — contributions of every size are welcome.

1. Fork & clone with submodules (`git clone --recurse-submodules`).
2. Pick an existing issue or open a new one to discuss.
3. Run `pnpm tauri dev` to hack.
4. Open a PR against `main`.

Areas that especially need help right now: **Linux packaging**, **UI polish / screenshots**, **docs & i18n**, and **CI for macOS signing**.

---

## 🙏 Acknowledgements

- **[Tencent WorkBuddy](https://workbuddy.tencent.com/)** — the design north star. EchoAgent reuses WorkBuddy's `--wb-*` design tokens, 207-icon foundation (all implemented), and brand atoms for a pixel-close visual experience.
- **[xai-org/grok-build](https://github.com/xai-org/grok-build)** — the Apache-2.0 upstream runtime component consumed as Rust path dependencies. See [Third-Party Notices](THIRD_PARTY_NOTICES.md).
- **[Tauri](https://tauri.app/)**, **[React](https://react.dev/)**, **[Vite](https://vitejs.dev/)** — the stack that makes a 10 MB shell feel instant.

This project is an independent, community-driven open-source effort and is not affiliated with, endorsed by, or sponsored by Tencent or xAI.

---

## License

MIT © EchoAgent contributors. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
