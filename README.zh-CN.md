<p align="center">
  <img src="app-icon.png" width="112" height="112" alt="EchoAgent Logo" />
</p>

<h1 align="center">EchoAgent</h1>

<p align="center">
  <strong>面向自主 AI Agent 的开源桌面工作台。</strong>
  <br />
  自带模型、连接 MCP 工具，在轻量原生应用中规划、执行与自动化复杂任务。
</p>

<p align="center">
  <a href="README.md">English</a>
  · <a href="#项目概览">项目概览</a>
  · <a href="#核心能力">核心能力</a>
  · <a href="#快速开始">快速开始</a>
  · <a href="#技术架构">技术架构</a>
  · <a href="#开发指南">开发指南</a>
  · <a href="#路线图">路线图</a>
</p>

<p align="center">
  <a href="https://github.com/fuyuxiang/echo-agent-desktop/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/fuyuxiang/echo-agent-desktop/ci.yml?branch=main&style=flat-square&label=CI" alt="CI 状态" /></a>
  <a href="https://github.com/fuyuxiang/echo-agent-desktop/stargazers"><img src="https://img.shields.io/github/stars/fuyuxiang/echo-agent-desktop?style=flat-square" alt="GitHub Stars" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square" alt="MIT 协议" /></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-2563eb?style=flat-square" alt="支持 Windows 和 macOS" />
  <img src="https://img.shields.io/badge/Tauri-2-24c8db?style=flat-square&logo=tauri&logoColor=white" alt="Tauri 2" />
  <img src="https://img.shields.io/badge/Rust-1.92%2B-dea584?style=flat-square&logo=rust&logoColor=white" alt="Rust 1.92 或更高版本" />
</p>

<p align="center">
  <img src="src/assets/landing-hero.png" alt="EchoAgent——人与 AI Agent 协同工作" width="100%" />
</p>

## 项目概览

EchoAgent 将模型 API 转化为真正可落地的桌面 Agent 工作环境。它把对话、文件、工具、权限、计划、子 Agent 与定时任务整合在同一个应用中，无需注册或依赖 EchoAgent 云端账户。

核心 Agent Runtime 直接嵌入 Tauri 进程，并通过 [Agent Client Protocol（ACP）](https://agentclientprotocol.com/)与 React 界面通信。流式输出、工具调用、权限审批、计划更新和任务生命周期因此共享同一条类型安全的执行链路。

> [!IMPORTANT]
> EchoAgent 目前仍处于 1.0 之前的快速迭代阶段。项目支持在 Windows 与 macOS 上从源码构建，现阶段安装包尚未进行代码签名或公证。允许 Agent 执行命令或修改文件前，请认真核对每一项权限请求。

### 设计原则

| 原则 | EchoAgent 的实现方式 |
| --- | --- |
| **供应商无关** | 使用自己的凭证接入 OpenAI、Anthropic、xAI、DeepSeek、通义千问或兼容的自定义服务。 |
| **以工作空间为核心** | 会话绑定真实目录，并提供文件上下文、变更、产物与可搜索的本地历史。 |
| **默认可扩展** | 通过 MCP Server、Skills、可复用助理和子 Agent 团队扩展能力。 |
| **控制边界清晰** | 文件夹信任、权限模式、允许/询问/拒绝规则和可见的工具调用让执行过程可检查。 |
| **原生且轻量** | 以 Tauri、Rust 和系统 WebView 构建桌面外壳，并在进程内运行 Agent Runtime。 |

## 核心能力

| 领域 | 能力 |
| --- | --- |
| **Agent 工作流** | 流式会话、可编辑计划、回溯与分叉、Prompt 历史、斜杠命令、子 Agent 实时任务、取消执行和团队状态。 |
| **模型接入** | 多 Provider、多模型、上下文窗口配置、模型列表发现，以及兼容 OpenAI 或 Anthropic 协议的自定义 Endpoint。 |
| **工具与扩展** | 基于 stdio 或 HTTP 的 MCP、MCP OAuth、Skills、Plugins、可复用助理和本地能力目录。 |
| **工作空间** | 按目录组织会话、置顶与归档、全文检索、文件树、文件预览、变更跟踪和 Unified Diff。 |
| **富内容交互** | 图片附件、拖拽输入、原生语音输入、代码高亮、GFM、KaTeX、Mermaid 和工具结果图片。 |
| **知识与记忆** | 持久化记忆管理、本地文件夹知识源、可复用项目上下文和助理定义。 |
| **自动化** | 单次或周期性本地调度、执行记录、连接器选择，以及自动化任务级权限模式。 |
| **外部集成** | WebDAV 存储，以及系统桌面、Slack、Discord 和通用 Webhook 通知。 |
| **安全与策略** | 行内权限审批、文件夹信任、权限规则、可配置执行模式，以及模型和功能策略控制。 |

## 快速开始

### 使用安装包

项目发布安装包后，可从 [GitHub Releases](https://github.com/fuyuxiang/echo-agent-desktop/releases) 下载。EchoAgent 支持生成 Windows NSIS 安装程序和 macOS DMG。

> [!WARNING]
> 当前安装包尚未进行代码签名或公证。请仅安装来自可信 Release 的产物，并在运行前核对对应的发布说明。

### 从源码构建

#### 环境要求

| 依赖 | 要求 |
| --- | --- |
| Rust | Stable 工具链，Rust 1.92 或更高版本。`rust-toolchain.toml` 会安装 `rustfmt` 和 `clippy`。 |
| Node.js | Node.js 20 或更高版本；CI 使用 Node.js 22。 |
| pnpm | pnpm 10。项目在 `package.json` 中固定了期望的包管理器版本。 |
| Protocol Buffers | 系统 `PATH` 中可用的原生 `protoc`，或通过 `PROTOC` 环境变量指定。 |
| 平台工具链 | macOS：Xcode Command Line Tools。Windows：Visual Studio 2022 Build Tools，并安装 **Desktop development with C++** 工作负载和 Windows SDK。 |

内嵌 Runtime 以固定版本的 Git Submodule 引入。请递归克隆仓库并执行 Setup 脚本，以确保使用正确的上游版本并应用兼容性补丁。

**macOS**

```bash
git clone --recurse-submodules https://github.com/fuyuxiang/echo-agent-desktop.git
cd echo-agent-desktop

pnpm setup:mac
pnpm install --frozen-lockfile
pnpm tauri dev
```

**Windows（PowerShell）**

```powershell
git clone --recurse-submodules https://github.com/fuyuxiang/echo-agent-desktop.git
cd echo-agent-desktop

pnpm setup:win
pnpm install --frozen-lockfile
.\dev.bat
```

首次构建需要编译完整的内嵌 Rust Runtime，可能耗时数分钟并占用较多磁盘空间，后续增量构建会明显更快。MSVC、`protoc` 和环境配置问题请参阅 [Windows 构建说明](docs/WINDOWS_BUILD_NOTES.md)。

### 配置第一个模型

1. 启动 EchoAgent，打开「设置 → 模型」。
2. 添加 Provider，填写 API Key 和 Endpoint。
3. 在该 Provider 下至少添加一个模型。
4. 在输入区选择模型并开始任务。

项目内置 Anthropic、OpenAI、xAI、DeepSeek 和通义千问配置预设，同时支持兼容 OpenAI 或 Anthropic 协议的自定义服务。

<details>
<summary><strong>手动配置</strong></summary>

界面会将 Provider 配置写入 `~/.echo-agent/config.toml`。以下是一个最小的 OpenAI 兼容配置：

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

手动编辑后请重启 EchoAgent。建议优先使用设置界面，因为它会校验 Provider 字段，并在更新时保留无关配置。

</details>

## 数据与安全

EchoAgent 默认将应用状态保存在 `~/.echo-agent/`。如需修改数据目录，请在启动前设置 `ECHO_AGENT_HOME`。

| 数据 | 默认位置 |
| --- | --- |
| Provider、权限、界面默认值和 MCP 配置 | `~/.echo-agent/config.toml` 与 `~/.echo-agent/mcp.json` |
| 会话与工作空间历史 | `~/.echo-agent/sessions/` |
| 可复用助理 | `~/.echo-agent/agents/` |
| 记忆与 Runtime 状态 | `~/.echo-agent/memory/` 及 EchoAgent 自有 JSON 文件 |

- API Key 和 Endpoint 凭证以明文形式保存在本机。Unix 系统下，EchoAgent 会为包含密钥的文件和目录设置仅所有者可访问的权限；Windows 下的访问边界取决于当前用户的文件系统 ACL。
- 模型、MCP、WebDAV 和通知流量只会发往你主动配置的服务，使用项目无需 EchoAgent 托管账户。
- 工具执行可能读取文件、修改文件或运行命令。处理不完全可信的仓库或数据时，请使用权限规则和受限模式。
- 不要将 `~/.echo-agent/config.toml`、复制出的凭证或 Runtime 状态提交到版本控制。

## 技术架构

```text
┌─────────────────────────────────────────────────────────────┐
│ React 18 界面                                               │
│ Components · Zustand Stores · Markdown · Workspace Views    │
└──────────────────────┬──────────────────────────────────────┘
                       │ Tauri Commands 与 Events
┌──────────────────────▼──────────────────────────────────────┐
│ Tauri 2 / Rust 应用层                                       │
│ Commands · Bridge · Sessions · Providers · Policy · Storage │
└──────────────────────┬──────────────────────────────────────┘
                       │ 基于 mpsc Channel 的类型化 ACP 消息
┌──────────────────────▼──────────────────────────────────────┐
│ 进程内 Agent Runtime                                        │
│ 会话生命周期 · 工具 · 计划 · 权限 · 子 Agent                │
└──────────────┬──────────────────┬───────────────────────────┘
               │                  │
          模型 Provider       MCP Server / 本地工具
```

Runtime 运行在独立 OS 线程上，由 current-thread Tokio Runtime 和 `LocalSet` 驱动。Rust Bridge 将 ACP 更新转换为 `agent://update`、`agent://permission`、`agent://complete` 等 Tauri Event，前端 Store 再将事件应用到对应会话。

### 目录结构

```text
src/
├── components/             React 视图与功能面板
├── foundation/             通用图标与 UI 基础组件
├── lib/                    ACP Client、领域逻辑与工具函数
├── stores/                 Zustand 应用状态
└── styles/                 Design Tokens 与应用样式

src-tauri/
├── src/agent_runtime.rs     内嵌 Runtime 生命周期
├── src/bridge.rs            ACP 到 Tauri 的事件桥接
├── src/commands.rs          会话命令入口
├── src/lib.rs               Tauri 初始化与命令注册
└── src/*.rs                 Provider、MCP、Skills、Policy、Storage 等模块

vendor/grok-build/           固定版本的 Apache-2.0 Runtime Submodule
patches/grok-build/          项目维护的兼容性补丁
scripts/                     初始化与打包脚本
docs/                        平台专项文档
.github/workflows/           持续集成配置
```

## 开发指南

### 常用命令

| 命令 | 用途 |
| --- | --- |
| `pnpm tauri dev` | 以开发模式运行完整桌面应用。 |
| `pnpm dev` | 仅运行 Vite 前端；普通浏览器环境无法使用 Tauri API。 |
| `pnpm test` | 运行 Vitest 前端测试。 |
| `pnpm build` | 执行 TypeScript 类型检查并生成生产环境前端产物。 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib` | 运行 Rust 单元测试。 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored spawn_smoke` | 运行需主动启用的内嵌 Runtime 冒烟测试。 |
| `pnpm dist:mac` | 在 macOS 上构建未签名 DMG。 |
| `pnpm dist:win` | 在 Windows 上构建未签名 NSIS 安装程序。 |

CI 会在每个 Pull Request 上执行 TypeScript 类型检查、前端单元测试和生产环境前端构建。涉及 Rust 的变更还应在本地运行对应的 Cargo 测试。

### 参与贡献

欢迎从小范围修复到 Runtime 新能力等各种形式的贡献。

1. Fork 仓库，并带 Submodule 克隆到本地。
2. 从 `main` 创建独立分支。
3. 为行为变更补充测试，并运行上方对应检查。
4. 保持变更范围清晰；行为发生变化时同步更新文档。
5. 创建 Pull Request，说明变更动机、实现要点和验证结果。

对于影响较大的功能或架构调整，请先创建 Issue，以便在编码前讨论设计方案与兼容性影响。

## 路线图

- Linux 开发支持与可分发安装包
- 已签名并完成公证的 Windows/macOS Release
- 自动化发布流程与产物校验和
- 官方维护的 Connector 与 Skill 目录
- 桌面端端到端测试与视觉回归测试
- 更完整的用户文档与界面国际化

路线图代表方向，不构成版本承诺。当前优先级请以 [Issue Tracker](https://github.com/fuyuxiang/echo-agent-desktop/issues) 为准。

## 常见问题

<details>
<summary><strong>是否支持本地模型？</strong></summary>

支持，但本地服务需要提供兼容 OpenAI 或 Anthropic 的 API。将其添加为自定义 Provider，并把 `base_url` 指向本地 Endpoint 即可。工具调用和多模态能力取决于具体模型与服务实现。

</details>

<details>
<summary><strong>是否支持 Linux？</strong></summary>

项目目前尚未维护 Linux 安装包。前端和大部分 Rust 代码具备可移植性，但桌面集成与打包仍需要针对 Linux 完成适配和验证。

</details>

<details>
<summary><strong>API Key 保存在什么位置？</strong></summary>

Provider Key 保存在 `~/.echo-agent/config.toml`。它不会写入项目仓库，但仍属于本机磁盘上的明文密钥。请妥善保护该文件，且不要将其附在 Issue、日志或 Commit 中。

</details>

## 致谢

- [xai-org/grok-build](https://github.com/xai-org/grok-build) 提供以固定 Rust Path Dependency 嵌入的 Apache-2.0 Runtime 组件。
- [Tauri](https://tauri.app/)、[React](https://react.dev/) 和 [Vite](https://vite.dev/) 构成项目的核心应用技术栈。
- [腾讯 WorkBuddy](https://workbuddy.tencent.com/) 为部分产品交互与视觉方向提供了启发。

EchoAgent 是独立的社区开源项目，与腾讯或 xAI 不存在隶属、背书或赞助关系。

## 许可证

EchoAgent 应用代码基于 [MIT License](LICENSE) 开源。Vendored 组件与其他第三方依赖继续遵循各自原始许可证，详见 [第三方许可说明](THIRD_PARTY_NOTICES.md)。
