import { describe, it, expect, afterEach, vi } from 'vitest'
import { initMemoryManager, getMemoryManager, resetMemoryManagerForTest } from '../singleton'
import type { ChatProvider, ChatDelta } from '../../providers'

// 在 vi.mock 工厂里直接用 import 引入 better-sqlite3(惰性求值避免模块提升问题)
vi.mock('../../../db', async () => {
  const Database = (await import('better-sqlite3')).default
  const { runMigrations } = await import('../../../db/migrations')
  const db = new Database(':memory:')
  runMigrations(db)
  return { getDb: () => db }
})

const provider: ChatProvider = {
  name: 'fake',
  async *chat(): AsyncIterable<ChatDelta> {
    yield { type: 'done' }
  }
}

afterEach(() => resetMemoryManagerForTest(null))

describe('memory singleton', () => {
  it('init 前 get 返回 null', () => {
    expect(getMemoryManager()).toBeNull()
  })
  it('init 后 get 返回同一实例', () => {
    const m = initMemoryManager({ provider, model: 'm', opts: { checkMs: 9_999_999 } })
    expect(getMemoryManager()).toBe(m)
    m.dispose()
  })
  it('重复 init 替换实例(旧的被 dispose)', () => {
    const a = initMemoryManager({ provider, model: 'm', opts: { checkMs: 9_999_999 } })
    const spy = vi.spyOn(a, 'dispose')
    const b = initMemoryManager({ provider, model: 'm2', opts: { checkMs: 9_999_999 } })
    expect(spy).toHaveBeenCalled()
    expect(getMemoryManager()).toBe(b)
    b.dispose()
  })
})
