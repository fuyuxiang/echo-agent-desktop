<p align="center">
  <img src="app-icon.png" width="96" height="96" alt="EchoAgent Logo" />
</p>

<h1 align="center">EchoAgent</h1>

<p align="center">
  <strong>不止回答问题，让 AI 在真实工作区里把事情做完。</strong>
  <br />
  EchoAgent 是一个开源、本地优先的桌面 Agent 工作台：连接你选择的模型，在可控权限下理解项目、操作文件、调用工具，并把复杂目标推进为可审查的交付结果。
</p>

<p align="center">
  <a href="README.en.md">English</a>
  · <a href="#快速开始">快速开始</a>
  · <a href="#核心能力">核心能力</a>
  · <a href="#工作原理">工作原理</a>
  · <a href="#数据与安全边界">安全边界</a>
  · <a href="https://github.com/fuyuxiang/echo-agent-desktop/issues">Issues</a>
</p>

<p align="center">
  <a href="https://github.com/fuyuxiang/echo-agent-desktop/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/fuyuxiang/echo-agent-desktop/ci.yml?branch=main&style=flat-square&label=CI" alt="CI 状态" /></a>
  <a href="https://github.com/fuyuxiang/echo-agent-desktop/stargazers"><img src="https://img.shields.io/github/stars/fuyuxiang/echo-agent-desktop?style=flat-square" alt="GitHub Stars" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square" alt="MIT 协议" /></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-2563eb?style=flat-square" alt="支持 Windows 和 macOS" />
  <img src="https://img.shields.io/badge/built%20with-Tauri%202-24c8db?style=flat-square&logo=tauri&logoColor=white" alt="基于 Tauri 2 构建" />
</p>

<p align="center">
  <img src="docs/images/echoagent-home.png" alt="EchoAgent 桌面端首页：选择工作目录、模型与权限模式后发起任务" width="100%" />
</p>

<p align="center"><sub>一个入口组织工作区、模型与权限；从这里描述你想完成的事情。</sub></p>

## 从一句目标，到一份可交付结果

真实工作很少止于一次问答。它需要理解上下文、拆解步骤、调用工具、处理反馈，还要让每一次操作都可以追踪。EchoAgent 围绕这条完整链路设计，而不是在聊天窗口外再堆一层功能。

| 原则 | EchoAgent 的设计选择 |
| --- | --- |
| **工作区原生** | 会话直接绑定真实目录，文件树、预览、搜索、变更和产物始终处于同一上下文 |
| **执行过程透明** | 计划、流式输出、工具调用、权限请求与 Unified Diff 都可查看和干预 |
| **模型与能力解耦** | 自带 API Key，按需组合不同模型、MCP、Skills、Plugins、专家与子 Agent |
| **面向持续协作** | 用项目、记忆、知识源与自动化沉淀上下文，让任务不必每次从零开始 |

<p align="center">
  <strong>目标 → 上下文 → 计划 → 工具执行 → 权限确认 → 文件变更 → 交付</strong>
</p>

任务执行期间，你可以调整计划，批准或拒绝敏感操作，随时取消执行，并从历史节点回溯或分叉会话。模型负责推进工作，最终控制权始终属于你。

## 快速开始

仓库已包含内嵌 Agent Runtime 及其锁定依赖的源码快照，正常克隆即可构建，无需初始化 Git Submodule。

<details>
<summary><strong>环境要求</strong></summary>

| 依赖 | 要求 |
| --- | --- |
| Node.js | 20 或更高版本；CI 使用 Node.js 22 |
| pnpm | 10；仓库已固定期望版本 |
| Rust | Stable，最低 `1.92.0`，包含 `rustfmt` 与 `clippy` |
| Protocol Buffers | 系统 `PATH` 中可用的原生 `protoc`，或设置 `PROTOC` |
| 平台工具链 | macOS：Xcode Command Line Tools；Windows：VS 2022 Build Tools、C++ 桌面工作负载和 Windows SDK |

</details>

### macOS

```bash
git clone https://github.com/fuyuxiang/echo-agent-desktop.git
cd echo-agent-desktop

pnpm setup:mac
pnpm install --frozen-lockfile
pnpm tauri dev
```

### Windows（PowerShell）

```powershell
git clone https://github.com/fuyuxiang/echo-agent-desktop.git
cd echo-agent-desktop

pnpm setup:win
pnpm install --frozen-lockfile
.\dev.bat
```

首次构建会编译完整的 Rust Runtime，因此会比后续增量构建耗时更长。

### 连接你的模型

1. 启动 EchoAgent，打开「设置 → 模型」。
2. 选择 Provider 并填写自己的 API Key；自定义服务还需配置 Endpoint 与协议。
3. 添加至少一个模型，可先测试连接。
4. 返回首页，选择工作目录、模型和权限模式，然后发送第一个任务。

<details>
<summary><strong>使用 TOML 手动配置</strong></summary>

设置界面最终写入 `~/.echo-agent/config.toml`。下面是一个最小的 OpenAI 兼容示例：

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

手动修改后请重启 EchoAgent。日常使用更推荐设置界面，因为它会校验字段并在更新时保留无关配置。

</details>

## 核心能力

| 领域 | 能力 |
| --- | --- |
| **Agent 执行** | 流式会话、可编辑计划、斜杠命令、任务取消、历史回溯与分叉、子 Agent 实时状态和团队协作 |
| **工作空间** | 目录级会话、全文检索、文件树、常见文档预览、变更跟踪、Unified Diff 与交付资产 |
| **模型接入** | OpenAI、Anthropic、DeepSeek、通义千问预设，多 Provider、多模型，以及 OpenAI/Anthropic 兼容 Endpoint |
| **能力扩展** | MCP stdio/HTTP、MCP OAuth、Skills、Plugins、连接器目录、可复用专家与本地能力市场 |
| **长期上下文** | 项目指令、任务与计划、个人记忆、会话摘要、本地文件夹知识源与可选组织知识服务 |
| **自动化与触达** | 单次或周期调度、运行记录、任务级权限、桌面通知、Slack、Discord、Webhook 与 WebDAV |
| **内容体验** | 文件与图片附件、拖拽、语音输入、GFM、语法高亮、KaTeX、Mermaid 和工具结果预览 |

## 工作原理

EchoAgent 不是套在命令行工具外的 Web 壳。Agent Runtime 直接嵌入桌面进程，通过类型化 ACP Channel 与 Tauri 应用层通信；会话状态、权限策略、调度和原生能力由 Rust 承担，React 负责可交互的任务界面。

```mermaid
flowchart TB
    UI[React 18 界面<br/>会话 · 项目 · 设置 · 工作空间] <-->|Tauri Commands / Events| HOST[Tauri 2 + Rust 应用层<br/>存储 · 策略 · 调度 · 原生能力]
    HOST <-->|类型化 ACP Channel| RUNTIME[进程内 Agent Runtime<br/>会话 · 计划 · 工具 · 权限 · 子 Agent]
    RUNTIME --> MODELS[模型 Provider<br/>OpenAI · Anthropic · Compatible]
    RUNTIME --> TOOLS[本地文件与命令<br/>MCP · Skills · Plugins]
    HOST --> DATA[(本地数据根目录<br/>.echo-agent)]
    HOST --> EXT[WebDAV · 通知 · 可选组织服务]
```

核心 Runtime 来自 [**`echo-agent`**](https://github.com/fuyuxiang/echo-agent)，入口 crate 为 `echo-agent-runtime`，锁定源码位于 `vendor/echo-agent-build/`。它运行在独立 OS 线程的 current-thread Tokio Runtime 与 `LocalSet` 中，Bridge 将流式更新、权限请求和计划状态转换为 Tauri Event，再分发到对应会话。

```text
src/                       React UI、Zustand Stores 与前端领域逻辑
src-tauri/src/             Tauri Commands、ACP Bridge、策略、存储与调度
vendor/echo-agent-build/   内嵌 Agent Runtime 的锁定源码快照
vendor/async-openai/       OpenAI 兼容 Rust 客户端源码快照
vendor/nucleo/             模糊匹配库源码快照
scripts/                   初始化、验证、构建与发布脚本
docs/                      平台构建与桌面更新文档
```

## 数据与安全边界

EchoAgent 默认将应用状态保存在 `~/.echo-agent/`；启动前设置 `ECHO_AGENT_HOME` 可以切换数据根目录。文件夹信任、任务权限模式以及允许/询问/拒绝规则共同约束工具执行。

| 数据 | 默认位置 |
| --- | --- |
| 模型、权限与运行配置 | `~/.echo-agent/config.toml` |
| MCP 配置 | `~/.echo-agent/mcp.json` |
| 会话与工作空间历史 | `~/.echo-agent/sessions/` |
| Agents、Skills 与记忆 | `~/.echo-agent/agents/`、`~/.echo-agent/skills/`、`~/.echo-agent/memory/` |
| 专家、连接器与内置技能目录 | `~/.echo-agent/experts-marketplace/`、`~/.echo-agent/connectors-marketplace/`、`~/.echo-agent/resources/builtin-skills/` |

- Provider API Key 当前保存在本机 `config.toml`。Unix 系统会收紧文件权限；Windows 的保护边界取决于当前用户 ACL。请勿将该文件提交到版本控制或附加到公开 Issue。
- “本地优先”指应用状态与执行控制位于本机，不代表完全离线。模型、MCP、WebDAV、通知和可选组织能力会访问各自配置的服务。
- 记忆默认开启；当前 Runtime 使用预设的 SiliconFlow Endpoint 完成 `BAAI/bge-m3` 向量化与 `BAAI/bge-reranker-v2-m3` 重排。处理敏感内容前请审查相关配置，或在「设置 → 记忆」中关闭。
- 对来源未知的仓库，建议使用「审批模式」、只授权必要目录，并逐项检查风险操作。

## 开发与验证

| 命令 | 用途 |
| --- | --- |
| `pnpm tauri dev` | 运行完整桌面应用 |
| `pnpm dev` | 仅启动 Vite 前端；原生能力需要 Tauri 容器 |
| `pnpm test` | 运行 Vitest 前端测试 |
| `pnpm build` | TypeScript 类型检查并构建前端 |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib -j 2` | 运行 Rust 单元测试 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | 检查 Rust 格式 |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` | 运行 Clippy |

CI 会在 `main` 推送和 Pull Request 上执行前端类型检查、单元测试、生产构建，以及 Rust 格式、Clippy 和单元测试检查。

## 路线图

- 更顺畅的 Windows 与 macOS 发布、安装和更新体验
- Linux 平台适配与分发
- 官方维护的 Connector、Skill 与 Plugin 目录
- 桌面端端到端测试与视觉回归测试
- 更完整的用户文档与界面国际化

路线图用于说明方向，不代表交付承诺；当前优先级以 [Issue Tracker](https://github.com/fuyuxiang/echo-agent-desktop/issues) 为准。

## 常见问题

<details>
<summary><strong>支持本地模型吗？</strong></summary>

支持。只要本地服务提供兼容 OpenAI 或 Anthropic 的 HTTP API，即可作为自定义 Provider 接入。工具调用和多模态能力取决于具体模型及服务实现。

</details>

<details>
<summary><strong>需要 EchoAgent 账户吗？</strong></summary>

个人使用不需要。模型使用你自己的凭证，主要状态保存在本机；组织能力是可选的外部服务入口。

</details>

<details>
<summary><strong>支持 Linux 吗？</strong></summary>

Linux 仍在适配中。前端和多数 Rust 模块具备可移植性，后续工作集中在文件对话框、系统通知、打包流程和平台验证。

</details>

## 参与贡献

欢迎提交 Bug 修复、测试、文档、界面改进、Provider/MCP 兼容性和 Runtime 能力增强。

1. Fork 仓库，并从 `main` 创建聚焦单一问题的分支。
2. 为行为变化补充相应测试和文档。
3. 运行与改动相关的前端或 Rust 检查。
4. 创建 Pull Request，说明动机、实现、风险与验证结果。

较大的功能或架构调整建议先创建 Issue，提前讨论交互、兼容性与安全边界。

## 致谢

EchoAgent 基于 [Tauri](https://tauri.app/)、[React](https://react.dev/) 与 [Vite](https://vite.dev/) 构建。内嵌 Agent Runtime 以固定源码快照维护，来源、兼容性修改和第三方许可记录在 [第三方许可说明](THIRD_PARTY_NOTICES.md) 中。

## 许可证

EchoAgent 应用代码基于 [MIT License](LICENSE) 开源。Vendored 组件与其他第三方依赖继续遵循各自原始许可证，详见 [第三方许可说明](THIRD_PARTY_NOTICES.md)。
