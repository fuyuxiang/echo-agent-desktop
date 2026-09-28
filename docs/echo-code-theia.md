# Echo Code 与 Theia 集成

「更多 → 代码开发」使用仓库内 Eclipse Theia 1.74.0 的浏览器 IDE。Theia 提供文件树、Monaco 编辑器、搜索、终端、Git 和网页预览；旁边的 EchoAgent 面板负责 Agent 会话、任务阶段、变更审阅、验证记录与交付。

## 构建与打包

- 开发机器使用 Node.js 22 或 24。`pnpm ide:build` 编译 [`vendor/theia-platform/`](../vendor/theia-platform/)，`pnpm ide:stage` 将 Theia 后端、生产依赖和当前平台的 Node.js 放入 Tauri 资源目录。
- `pnpm tauri dev` 和 `pnpm tauri build` 的前置钩子会运行 `pnpm ide:prepare`；缺少资源、架构变化或源码更新时重新构建和暂存。安装包中的 IDE 使用随包分发的 Node.js，普通用户不需另装。
- 如启动失败，先看应用数据目录中的 `theia.log`。开发者可以用 [`smoke-theia.mjs`](../scripts/smoke-theia.mjs) 检查内嵌页面与桥接。

## 运行与权限边界

Tauri 的 `coding_theia_start` 先检查选定目录是否为 EchoAgent 已授权工作区，再在 `127.0.0.1` 启动 Theia 后端。进程使用启动时生成的令牌验证就绪状态；切换项目时重启后端，关闭应用时停止进程。React 宿主与 Theia iframe 的消息桥校验来源和每帧令牌，文件写入前检查任务阶段，写入后同步变更集。

Theia 的文件操作和交互终端以当前系统用户身份运行。授权工作区是工作台范围，不是操作系统沙箱；打开来源未知的项目时仍应检查终端命令与扩展。Windows 启动路径和工作区桥接会处理中文及长路径兼容。

关键实现见 [`theia.rs`](../src-tauri/src/theia.rs)、[`TheiaIdeFrame.tsx`](../src/features/coding/TheiaIdeFrame.tsx) 和 [`prepare-theia.mjs`](../scripts/prepare-theia.mjs)。
