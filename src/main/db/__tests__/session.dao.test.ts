import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../migrations'

// 替换默认 getDb,指向测试用 in-memory db
let testDb: Database.Database

// 用 vi.mock 拦截 dao/session.ts 中的 getDb
vi.mock('../index', () => ({
  getDb: () => testDb
}))

import { appendChatMessage, getChatMessages, upsertChatSession } from '../dao/session'

beforeEach(() => {
  testDb = new Database(':memory:')
  runMigrations(testDb)
  upsertChatSession({ chatId: 'chat-1', title: 'Test Chat' })
})

afterEach(() => {
  testDb.close()
})

describe('session DAO 工具轨迹列', () => {
  it('assistant 消息可携带 toolCalls 并往返', () => {
    const toolCalls = [
      { id: 'tc_1', name: 'read_file', arguments: '{"path":"/tmp/a.txt"}' },
      { id: 'tc_2', name: 'list_dir', arguments: '{"path":"/tmp"}' }
    ]
    const inserted = appendChatMessage({
      chatId: 'chat-1',
      role: 'assistant',
      content: '',
      toolCalls
    })
    expect(inserted.toolCalls).toEqual(toolCalls)

    const messages = getChatMessages('chat-1')
    expect(messages).toHaveLength(1)
    expect(messages[0].toolCalls).toEqual(toolCalls)
  })

  it('tool 消息可携带 toolCallId + toolName 并往返', () => {
    appendChatMessage({
      chatId: 'chat-1',
      role: 'tool',
      content: '文件内容',
      toolCallId: 'tc_1',
      toolName: 'read_file'
    })
    const messages = getChatMessages('chat-1')
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('tool')
    expect(messages[0].toolCallId).toBe('tc_1')
    expect(messages[0].toolName).toBe('read_file')
    expect(messages[0].toolCalls).toBeUndefined()
  })

  it('user 消息不带工具字段时为 undefined', () => {
    appendChatMessage({
      chatId: 'chat-1',
      role: 'user',
      content: 'hello'
    })
    const messages = getChatMessages('chat-1')
    expect(messages[0].toolCalls).toBeUndefined()
    expect(messages[0].toolCallId).toBeUndefined()
    expect(messages[0].toolName).toBeUndefined()
  })
})
