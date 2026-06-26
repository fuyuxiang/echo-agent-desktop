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
})
