// src/main/agent/tools/__tests__/scope.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// electron-store 依赖 electron app.*, node 环境需 mock 掉
vi.mock('electron', () => ({
  app: {
    getPath: () => os.tmpdir(),
    getAppPath: () => os.tmpdir(),
    isPackaged: false
  },
  safeStorage: { isEncryptionAvailable: () => false }
}))

// 内存 KV 模拟 electron-store (顶层 vi.mock 会被 hoist)
const kvRef: { current: Map<string, unknown> } = { current: new Map() }
vi.mock('electron-store', () => ({
  default: class FakeStore {
    get(k: string): unknown {
      return kvRef.current.get(k)
    }
    set(k: string, v: unknown): void {
      kvRef.current.set(k, v)
    }
    delete(k: string): void {
      kvRef.current.delete(k)
    }
    clear(): void {
      kvRef.current.clear()
    }
  }
}))

beforeEach(() => {
  kvRef.current = new Map()
  vi.resetModules()
})

describe('scope', () => {
  it('无记录时默认 full', async () => {
    const { getScopeConfig } = await import('../scope')
    expect(getScopeConfig().scope).toBe('full')
  })
  it('full 档 assertInScope 任意路径放行', async () => {
    kvRef.current.set('agent.scope', 'full')
    const { assertInScope } = await import('../scope')
    expect((await assertInScope('/etc/hosts')).ok).toBe(true)
  })
  it('restricted 档子树内放行、越界拒绝', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-ws-'))
    kvRef.current.set('agent.scope', 'restricted')
    kvRef.current.set('agent.workspaceDir', ws)
    const { assertInScope } = await import('../scope')
    expect((await assertInScope(path.join(ws, 'a/b.txt'))).ok).toBe(true)
    expect((await assertInScope(path.join(ws, '../escape.txt'))).ok).toBe(false)
    expect((await assertInScope('/etc/hosts')).ok).toBe(false)
  })
  it('restricted 档拒绝经符号链接指向外部的路径(防穿越)', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-ws-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-out-'))
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x')
    // 在 workspace 内建一个指向外部目录的软链
    const link = path.join(ws, 'link')
    fs.symlinkSync(outside, link)
    kvRef.current.set('agent.scope', 'restricted')
    kvRef.current.set('agent.workspaceDir', ws)
    const { assertInScope } = await import('../scope')
    // 词法上 link/secret.txt 在 ws 内,但 realpath 指向外部,应拒绝
    expect((await assertInScope(path.join(link, 'secret.txt'))).ok).toBe(false)
  })
})
