import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) }
}))

import { IpcChannels } from '@shared/ipc-channels'
import { registerAgentMemoryIpc } from '../agent-memory'
import { resetMemoryManagerForTest } from '../../agent/memory/singleton'
import { MemoryManager } from '../../agent/memory/manager'
import Database from 'better-sqlite3'
import { runMigrations } from '../../db/migrations'
import type { ChatProvider, ChatDelta } from '../../agent/providers'

const provider: ChatProvider = {
  name: 'fake',
  async *chat(): AsyncIterable<ChatDelta> {
    yield { type: 'done' }
  }
}

beforeEach(() => {
  handlers.clear()
  registerAgentMemoryIpc()
})
afterEach(() => resetMemoryManagerForTest(null))

function invoke(ch: string, ...args: unknown[]): unknown {
  return handlers.get(ch)!({}, ...args)
}

describe('agent-memory IPC', () => {
  it('未初始化时 list 返回空数组,stats 返回零值,不崩', () => {
    expect(invoke(IpcChannels.agentMemory.list, { limit: 10, offset: 0 })).toEqual([])
    const s = invoke(IpcChannels.agentMemory.stats) as { total: number }
    expect(s.total).toBe(0)
  })

  it('初始化后 list/get/delete 走门面', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    const mgr = new MemoryManager({ db, provider, model: 'm', opts: { checkMs: 9_999_999 } })
    resetMemoryManagerForTest(mgr)
    const rec = mgr['dao'].insertMemory({ content: '用户喜欢茶', memType: 'user', tier: 'semantic', importance: 6 })
    expect((invoke(IpcChannels.agentMemory.list, { limit: 10, offset: 0 }) as unknown[]).length).toBe(1)
    const got = invoke(IpcChannels.agentMemory.get, { id: rec.id }) as { record: { content: string } }
    expect(got.record.content).toBe('用户喜欢茶')
    invoke(IpcChannels.agentMemory.delete, { id: rec.id })
    expect((invoke(IpcChannels.agentMemory.list, { limit: 10, offset: 0 }) as unknown[]).length).toBe(0)
  })
})
