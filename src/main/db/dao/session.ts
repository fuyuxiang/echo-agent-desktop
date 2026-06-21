import { getDb } from '../index'

/**
 * 会话与消息 DAO(本地 SQLite,展示层唯一可信来源)
 *
 * 范式见 dao/example.ts 顶部注释。所有方法同步,渲染层经 IPC -> 此处。
 */

export interface SessionRow {
  chatId: string
  title: string | null
  platform: string
  createdAt: number
  lastActivity: number
  messageCount: number
  pinned: number
}

export interface MessageRow {
  id: number
  chatId: string
  role: string
  content: string
  reasoning: string | null
  createdAt: number
}

interface RawSession {
  chat_id: string
  title: string | null
  platform: string
  created_at: number
  last_activity: number
  message_count: number
  pinned: number
}

interface RawMessage {
  id: number
  chat_id: string
  role: string
  content: string
  reasoning: string | null
  created_at: number
}

function toSession(r: RawSession): SessionRow {
  return {
    chatId: r.chat_id,
    title: r.title,
    platform: r.platform,
    createdAt: r.created_at,
    lastActivity: r.last_activity,
    messageCount: r.message_count,
    pinned: r.pinned
  }
}

function toMessage(r: RawMessage): MessageRow {
  return {
    id: r.id,
    chatId: r.chat_id,
    role: r.role,
    content: r.content,
    reasoning: r.reasoning,
    createdAt: r.created_at
  }
}

/** 会话列表(按最近活动倒序) */
export function listChatSessions(): SessionRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM chat_sessions ORDER BY last_activity DESC')
    .all() as RawSession[]
  return rows.map(toSession)
}

/** 创建会话(已存在则保留原标题/计数,仅确保存在) */
export function upsertChatSession(input: {
  chatId: string
  title?: string | null
  platform?: string
}): void {
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO chat_sessions (chat_id, title, platform, created_at, last_activity, message_count, pinned)
       VALUES (@chatId, @title, @platform, @now, @now, 0, 0)
       ON CONFLICT(chat_id) DO NOTHING`
    )
    .run({
      chatId: input.chatId,
      title: input.title ?? null,
      platform: input.platform ?? 'desktop',
      now
    })
}

/** 删除会话及其全部消息(显式事务,不依赖外键) */
export function deleteChatSession(chatId: string): void {
  const db = getDb()
  db.transaction(() => {
    db.prepare('DELETE FROM chat_messages WHERE chat_id = ?').run(chatId)
    db.prepare('DELETE FROM chat_sessions WHERE chat_id = ?').run(chatId)
  })()
}

/** 某会话全部消息(时间升序) */
export function getChatMessages(chatId: string): MessageRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY created_at ASC, id ASC')
    .all(chatId) as RawMessage[]
  return rows.map(toMessage)
}

/** 追加一条消息,同事务更新会话 last_activity 与 message_count */
export function appendChatMessage(input: {
  chatId: string
  role: string
  content: string
  reasoning?: string | null
}): MessageRow {
  const db = getDb()
  const createdAt = Date.now()
  const id = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO chat_messages (chat_id, role, content, reasoning, created_at)
         VALUES (@chatId, @role, @content, @reasoning, @createdAt)`
      )
      .run({
        chatId: input.chatId,
        role: input.role,
        content: input.content,
        reasoning: input.reasoning ?? null,
        createdAt
      })
    db.prepare(
      `UPDATE chat_sessions
       SET last_activity = @createdAt, message_count = message_count + 1
       WHERE chat_id = @chatId`
    ).run({ createdAt, chatId: input.chatId })
    return Number(result.lastInsertRowid)
  })()
  return {
    id,
    chatId: input.chatId,
    role: input.role,
    content: input.content,
    reasoning: input.reasoning ?? null,
    createdAt
  }
}

/** 更新会话标题 */
export function updateChatSessionTitle(chatId: string, title: string): void {
  getDb().prepare('UPDATE chat_sessions SET title = ? WHERE chat_id = ?').run(title, chatId)
}

/**
 * 删除某会话最后一条 assistant 消息(用于重新生成,撤销上一轮回复)
 * 同事务内删消息 + 把 message_count 减一(不减成负数);无 assistant 消息则空操作
 */
export function deleteLastAssistantMessage(chatId: string): void {
  const db = getDb()
  db.transaction(() => {
    const row = db
      .prepare(
        `SELECT id FROM chat_messages
         WHERE chat_id = ? AND role = 'assistant'
         ORDER BY created_at DESC, id DESC
         LIMIT 1`
      )
      .get(chatId) as { id: number } | undefined
    if (!row) return
    db.prepare('DELETE FROM chat_messages WHERE id = ?').run(row.id)
    db.prepare(
      `UPDATE chat_sessions
       SET message_count = MAX(0, message_count - 1)
       WHERE chat_id = ?`
    ).run(chatId)
  })()
}
