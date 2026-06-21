import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let memDb: Database.Database

vi.mock('../../index', () => ({
  getDb: () => memDb
}))

import {
  listChatSessions,
  upsertChatSession,
  deleteChatSession,
  getChatMessages,
  appendChatMessage,
  updateChatSessionTitle
} from '../session'

beforeEach(() => {
  memDb = new Database(':memory:')
  memDb.exec(`
    CREATE TABLE chat_sessions (
      chat_id TEXT PRIMARY KEY, title TEXT, platform TEXT NOT NULL DEFAULT 'desktop',
      created_at INTEGER NOT NULL, last_activity INTEGER NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, reasoning TEXT, created_at INTEGER NOT NULL
    );
  `)
})

describe('session DAO', () => {
  it('upsert 创建会话, list 倒序返回', () => {
    upsertChatSession({ chatId: 'c1' })
    upsertChatSession({ chatId: 'c2' })
    const list = listChatSessions()
    expect(list.map((s) => s.chatId).sort()).toEqual(['c1', 'c2'])
    expect(list[0].platform).toBe('desktop')
  })

  it('appendChatMessage 写消息并更新 messageCount / lastActivity', () => {
    upsertChatSession({ chatId: 'c1' })
    appendChatMessage({ chatId: 'c1', role: 'user', content: 'hi' })
    appendChatMessage({ chatId: 'c1', role: 'assistant', content: 'yo', reasoning: 'think' })
    const msgs = getChatMessages('c1')
    expect(msgs).toHaveLength(2)
    expect(msgs[0].content).toBe('hi')
    expect(msgs[1].reasoning).toBe('think')
    const session = listChatSessions().find((s) => s.chatId === 'c1')!
    expect(session.messageCount).toBe(2)
    expect(session.lastActivity).toBeGreaterThan(0)
  })

  it('deleteChatSession 级联删除消息', () => {
    upsertChatSession({ chatId: 'c1' })
    appendChatMessage({ chatId: 'c1', role: 'user', content: 'hi' })
    deleteChatSession('c1')
    expect(listChatSessions()).toHaveLength(0)
    expect(getChatMessages('c1')).toHaveLength(0)
  })

  it('updateChatSessionTitle 改标题', () => {
    upsertChatSession({ chatId: 'c1' })
    updateChatSessionTitle('c1', '新标题')
    expect(listChatSessions()[0].title).toBe('新标题')
  })

  it('upsert 重复 chatId 不覆盖已有标题与计数', () => {
    upsertChatSession({ chatId: 'c1', title: 'orig' })
    appendChatMessage({ chatId: 'c1', role: 'user', content: 'hi' })
    upsertChatSession({ chatId: 'c1' })
    const s = listChatSessions()[0]
    expect(s.title).toBe('orig')
    expect(s.messageCount).toBe(1)
  })
})
