// src/main/agent/tools/__tests__/shell.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import os from 'node:os'
import type { ToolContext } from '../base'

const ctx = (signal?: AbortSignal): ToolContext => ({
  chatId: 'c1',
  workspace: os.tmpdir(),
  signal: signal ?? new AbortController().signal,
  onProgress: () => {}
})

beforeEach(() => {
  vi.resetModules()
  vi.doMock('../scope', () => ({ resolveWorkspace: () => os.tmpdir() }))
  // 默认放行,聚焦 shell 执行机制;拒绝路径在 broker 与下面的用例单独覆盖
  vi.doMock('../../permission/broker', () => ({ decide: async () => ({ allow: true }) }))
})

describe('shell tool', () => {
  it('执行 echo 返回输出', async () => {
    const { shellTool } = await import('../shell')
    const r = await shellTool.execute({ command: 'echo hello' }, ctx())
    expect(r.ok).toBe(true)
    expect(r.content).toContain('hello')
  })
  it('超时返回 ok:false 且不挂起', async () => {
    const { shellTool } = await import('../shell')
    const r = await shellTool.execute({ command: 'sleep 5', timeoutMs: 200 }, ctx())
    expect(r.ok).toBe(false)
    expect(r.content).toContain('超时')
  })
  it('abort 中断', async () => {
    const { shellTool } = await import('../shell')
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 100)
    const r = await shellTool.execute({ command: 'sleep 5' }, ctx(ac.signal))
    expect(r.ok).toBe(false)
  })
  it('broker 拒绝时不执行命令,返回拒绝理由', async () => {
    vi.doMock('../../permission/broker', () => ({
      decide: async () => ({ allow: false, reason: '受限档已禁用 shell' })
    }))
    const { shellTool } = await import('../shell')
    const r = await shellTool.execute({ command: 'echo should-not-run' }, ctx())
    expect(r.ok).toBe(false)
    expect(r.content).toContain('受限档')
    expect(r.content).not.toContain('should-not-run')
  })
  it.skipIf(process.platform === 'win32')(
    '子进程 env 净化:敏感变量不透传,PATH 保留',
    async () => {
      process.env.ECHO_SECRET_TOKEN = 'super-secret'
      try {
        const { shellTool } = await import('../shell')
        const leak = await shellTool.execute({ command: 'echo "[$ECHO_SECRET_TOKEN]"' }, ctx())
        expect(leak.content).toContain('[]') // 变量为空,未透传
        expect(leak.content).not.toContain('super-secret')
        const path = await shellTool.execute({ command: 'echo "$PATH"' }, ctx())
        expect(path.content.trim().length).toBeGreaterThan(0) // PATH 仍在,命令能跑
      } finally {
        delete process.env.ECHO_SECRET_TOKEN
      }
    }
  )
})
