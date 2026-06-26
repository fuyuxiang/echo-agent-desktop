// src/main/agent/permission/__tests__/approval-bridge.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// 收集 ipcMain.handle 注册的 handler,便于测试直接调用
const handlers = new Map<string, (...a: unknown[]) => unknown>()
let windowsCount = 1
const sent: Array<{ channel: string; payload: unknown }> = []

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn)
  },
  BrowserWindow: {
    getAllWindows: () =>
      Array.from({ length: windowsCount }, () => ({
        webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) }
      }))
  }
}))

vi.mock('../../../logger', () => ({ log: { warn: () => {}, info: () => {}, error: () => {} } }))

// 捕获注入 broker 的 approver
let injectedApprover: ((req: unknown) => Promise<string>) | null = null
vi.mock('../broker', () => ({
  setApprover: (fn: ((req: unknown) => Promise<string>) | null) => {
    injectedApprover = fn
  },
  extractProgram: (cmd: string) => cmd.trim().split(/\s+/)[0] || null
}))

import { IpcChannels } from '@shared/ipc-channels'

beforeEach(() => {
  handlers.clear()
  sent.length = 0
  windowsCount = 1
  injectedApprover = null
  vi.resetModules()
  vi.useRealTimers()
})

async function setup(): Promise<void> {
  const { registerApprovalBridge } = await import('../approval-bridge')
  registerApprovalBridge()
}

describe('approval-bridge', () => {
  it('注册后注入 approver 且监听 respond', async () => {
    await setup()
    expect(typeof injectedApprover).toBe('function')
    expect(handlers.has(IpcChannels.agentPermission.respond)).toBe(true)
  })

  it('无窗口时按拒绝处理', async () => {
    await setup()
    windowsCount = 0
    const choice = await injectedApprover!({
      chatId: 'c1',
      action: { kind: 'shell', command: 'ls' }
    })
    expect(choice).toBe('deny')
  })

  it('向窗口发请求,渲染层 respond 后兑现选择', async () => {
    await setup()
    const p = injectedApprover!({ chatId: 'c1', action: { kind: 'shell', command: 'ls -la' } })
    // 已向窗口发出 request
    expect(sent[0].channel).toBe(IpcChannels.agentPermission.request)
    const req = sent[0].payload as { requestId: string }
    // 模拟渲染层应答
    const respond = handlers.get(IpcChannels.agentPermission.respond)!
    respond({}, { requestId: req.requestId, choice: 'allow_session' })
    expect(await p).toBe('allow_session')
  })

  it('非法 choice 归一为 deny', async () => {
    await setup()
    const p = injectedApprover!({ chatId: 'c1', action: { kind: 'shell', command: 'ls' } })
    const req = sent[0].payload as { requestId: string }
    handlers.get(IpcChannels.agentPermission.respond)!({}, {
      requestId: req.requestId,
      choice: 'bogus'
    })
    expect(await p).toBe('deny')
  })

  it('signal abort 时按拒绝兜底', async () => {
    await setup()
    const ac = new AbortController()
    const p = injectedApprover!({
      chatId: 'c1',
      action: { kind: 'shell', command: 'sleep 1' },
      signal: ac.signal
    })
    ac.abort()
    expect(await p).toBe('deny')
  })

  it('非 shell 动作直接放行(不弹窗)', async () => {
    await setup()
    const choice = await injectedApprover!({
      chatId: 'c1',
      action: { kind: 'fs-read', path: '/x' }
    })
    expect(choice).toBe('allow_once')
    expect(sent.length).toBe(0)
  })
})
