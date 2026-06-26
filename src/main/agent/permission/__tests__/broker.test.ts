// src/main/agent/permission/__tests__/broker.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import os from 'node:os'

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => os.tmpdir(), isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false }
}))

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

const ctx = { chatId: 'c1' }

beforeEach(() => {
  kvRef.current = new Map()
  vi.resetModules()
})

describe('permission broker', () => {
  it('full 档放行 shell,无需审批', async () => {
    kvRef.current.set('agent.scope', 'full')
    const { decide, setApprover } = await import('../broker')
    const approver = vi.fn()
    setApprover(approver)
    expect((await decide({ kind: 'shell', command: 'rm -rf /' }, ctx)).allow).toBe(true)
    expect(approver).not.toHaveBeenCalled()
  })

  it('restricted 无 approver 时安全默认拒绝', async () => {
    kvRef.current.set('agent.scope', 'restricted')
    const { decide, setApprover } = await import('../broker')
    setApprover(null)
    const d = await decide({ kind: 'shell', command: 'ls' }, ctx)
    expect(d.allow).toBe(false)
  })

  it('restricted 下 approver 返回 allow_once 放行,但不记住', async () => {
    kvRef.current.set('agent.scope', 'restricted')
    const { decide, setApprover } = await import('../broker')
    const approver = vi.fn().mockResolvedValue('allow_once')
    setApprover(approver)
    expect((await decide({ kind: 'shell', command: 'ls' }, ctx)).allow).toBe(true)
    expect((await decide({ kind: 'shell', command: 'ls' }, ctx)).allow).toBe(true)
    expect(approver).toHaveBeenCalledTimes(2) // 每次都问
  })

  it('allow_session 记住程序名,同会话同程序不再询问', async () => {
    kvRef.current.set('agent.scope', 'restricted')
    const { decide, setApprover, clearSessionAllowlist } = await import('../broker')
    clearSessionAllowlist()
    const approver = vi.fn().mockResolvedValue('allow_session')
    setApprover(approver)
    expect((await decide({ kind: 'shell', command: 'ls -la' }, ctx)).allow).toBe(true)
    expect((await decide({ kind: 'shell', command: 'ls /tmp' }, ctx)).allow).toBe(true)
    expect(approver).toHaveBeenCalledTimes(1) // 第二次命中 allowlist
  })

  it('allowlist 不跨会话', async () => {
    kvRef.current.set('agent.scope', 'restricted')
    const { decide, setApprover, clearSessionAllowlist } = await import('../broker')
    clearSessionAllowlist()
    const approver = vi.fn().mockResolvedValue('allow_session')
    setApprover(approver)
    await decide({ kind: 'shell', command: 'ls' }, { chatId: 'c1' })
    await decide({ kind: 'shell', command: 'ls' }, { chatId: 'c2' })
    expect(approver).toHaveBeenCalledTimes(2)
  })

  it('复合命令(含管道/分号)不走 allowlist,即便同程序也每次询问', async () => {
    kvRef.current.set('agent.scope', 'restricted')
    const { decide, setApprover, clearSessionAllowlist } = await import('../broker')
    clearSessionAllowlist()
    const approver = vi.fn().mockResolvedValue('allow_session')
    setApprover(approver)
    await decide({ kind: 'shell', command: 'cat a' }, ctx) // 记住 cat
    // 借已授权的 cat 夹带 rm,因含管道,不命中 allowlist
    const d = await decide({ kind: 'shell', command: 'cat a | rm -rf ~' }, ctx)
    expect(approver).toHaveBeenCalledTimes(2)
    expect(d.allow).toBe(true) // 本次审批仍 allow_session,但关键是没被静默放行
  })

  it('restricted 下 deny 拒绝并给理由', async () => {
    kvRef.current.set('agent.scope', 'restricted')
    const { decide, setApprover } = await import('../broker')
    setApprover(vi.fn().mockResolvedValue('deny'))
    const d = await decide({ kind: 'shell', command: 'ls' }, ctx)
    expect(d.allow).toBe(false)
    if (!d.allow) expect(d.reason).toContain('受限')
  })

  it('restricted 放行已通过校验的 fs/web 动作,不触发审批', async () => {
    kvRef.current.set('agent.scope', 'restricted')
    const { decide, setApprover } = await import('../broker')
    const approver = vi.fn()
    setApprover(approver)
    expect((await decide({ kind: 'fs-read', path: '/ws/a' }, ctx)).allow).toBe(true)
    expect((await decide({ kind: 'web', url: 'https://e.com' }, ctx)).allow).toBe(true)
    expect(approver).not.toHaveBeenCalled()
  })

  it('extractProgram 提取程序名,复合命令返回 null', async () => {
    const { extractProgram } = await import('../broker')
    expect(extractProgram('ls -la /tmp')).toBe('ls')
    expect(extractProgram('  git   status ')).toBe('git')
    expect(extractProgram('cat a | sh')).toBeNull()
    expect(extractProgram('a && b')).toBeNull()
    expect(extractProgram('echo `whoami`')).toBeNull()
    expect(extractProgram('FOO=bar env')).toBeNull()
    expect(extractProgram('')).toBeNull()
  })
})
