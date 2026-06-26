// src/main/agent/session/__tests__/SessionManager.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const dao = {
  upsertChatSession: vi.fn(),
  appendChatMessage: vi.fn((i) => ({ id: 1, ...i, reasoning: null, createdAt: 0 })),
  getChatMessages: vi.fn(() => []),
  listChatSessions: vi.fn(() => []),
  deleteChatSession: vi.fn()
}
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.doMock('../../../db/dao/session', () => dao)
})

describe('SessionManager', () => {
  it('同 chatId 二次 acquire 返回 null(串行)', async () => {
    const { SessionManager } = await import('../SessionManager')
    const m = new SessionManager()
    expect(m.acquire('c1')).not.toBeNull()
    expect(m.acquire('c1')).toBeNull()
    expect(m.isBusy('c1')).toBe(true)
  })
  it('release 后可再次 acquire', async () => {
    const { SessionManager } = await import('../SessionManager')
    const m = new SessionManager()
    m.acquire('c1')
    m.release('c1')
    expect(m.acquire('c1')).not.toBeNull()
  })
  it('不同 chatId 并行各自持锁', async () => {
    const { SessionManager } = await import('../SessionManager')
    const m = new SessionManager()
    expect(m.acquire('c1')).not.toBeNull()
    expect(m.acquire('c2')).not.toBeNull()
  })
  it('abort 触发对应 controller 的 signal', async () => {
    const { SessionManager } = await import('../SessionManager')
    const m = new SessionManager()
    const ac = m.acquire('c1')!
    let aborted = false
    ac.signal.addEventListener('abort', () => (aborted = true))
    m.abort('c1')
    expect(aborted).toBe(true)
  })
})
