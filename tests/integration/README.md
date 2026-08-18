# 集成测试（Integration Tests）

> 2026-08 审计驱动的反向回归测试集，每个测试覆盖一个 P0 bug 的端到端链路。

## 设计原则

- **跨模块**：必须跨越 IPC → 主进程 handler → 后端 gateway（或 preload 桥接）的完整链路，单元测试覆盖不到的薄弱点。
- **反向回归**：测试名以 `Regression:` 前缀，且断言是**正确行为**而非固化错误行为。
- **不依赖真实服务**：用 mock 替换 echo-agent / 数据库，模拟"未就绪"和"出错"路径。
- **可独立运行**：`npm test` 默认包含本目录；CI 增量改动时可只跑本目录。

## 当前覆盖（按 P0 编号）

| 测试 | 覆盖的 P0 | 关键断言 |
|---|---|---|
| `switch-session-no-empty-send.test.ts` | P0-3 切换会话不触发 send | `agentChat.switchSession` 后任何 `agentChat.send` 调用都不应被触发 |
| `stop-really-aborts.test.ts` | P0-5 Stop 调 abort | Chat 页面 `handleStop` 调用必须经 IPC 触发后端 abort 帧 |
| `local-scope-zero-network.test.ts` | P0-6 仅本机零网络 | `orgStore.retrieve` 在 `askScope='local'` 时不调用 `org.retrieve` |
| `first-launch.test.ts` | P0-1 启动可选 | StartupGate 默认渲染 children；sessionStorage 标记后绕过拦截 |
| `apikey-secure-store-only.test.ts` | P0-7 API Key 单一来源 | `ModelSection.handleSave` 后磁盘 config 不含明文 key；yaml 中 apiKey 是 `ref:` 占位符 |
| `cross-page-recorder.test.ts` | P0-8 录音全局 | RecorderIndicator 在 `recording=true` 时挂载到 AppLayout，不依赖 Chat 页 |
| `windows-titlebar.test.ts` | P0-2 自定义标题栏 | `frame:false` 的窗口必须接 TitleBar 组件；macOS 走 hiddenInset |
| `signout-invariant.test.ts` | P0-11 退出后 401 | signOut 清空 safeStorage / cache；任何 org API 调用必须 401 |

## 运行

```bash
npm test -- tests/integration/
```

## 添加新测试

按以下结构：

```ts
import { describe, it, expect, vi } from 'vitest'

describe('Regression: <P0 简述>', () => {
  it('<可执行描述>', () => {
    // ... 跨模块 mock + 端到端断言
  })
})
```

测试命名遵循 `Regression: <bug 描述>` 前缀，方便 grep 全量 P0 覆盖。
