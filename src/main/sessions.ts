import { randomUUID } from 'crypto'
import type {
  SessionConfig,
  SessionMessage,
  SessionListResponse,
  SessionSearchRequest,
  SessionSearchResponse,
  SessionExportData,
  SessionImportData,
  SessionUpdateRequest
} from '../shared/session-types'
import { storeGet, storeSet } from './store'

const SESSIONS_KEY = 'sessions.sessions'
const MESSAGES_KEY = 'sessions.messages'

/** 读取会话列表 */
function getSessions(): SessionConfig[] {
  return storeGet<SessionConfig[]>(SESSIONS_KEY) ?? []
}

/** 读取消息列表 */
function getMessages(): SessionMessage[] {
  return storeGet<SessionMessage[]>(MESSAGES_KEY) ?? []
}

/** 创建新会话 */
export async function createSession(request: { title: string; metadata?: Record<string, unknown> }): Promise<SessionConfig> {
  const sessions = getSessions()
  const now = new Date().toISOString()
  const newSession: SessionConfig = {
    id: randomUUID(),
    title: request.title,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    isActive: true,
    metadata: request.metadata
  }
  sessions.push(newSession)
  storeSet(SESSIONS_KEY, sessions)
  return newSession
}

/** 列出所有会话，按日期分组 */
export async function listSessions(): Promise<SessionListResponse> {
  const sessions = getSessions()
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)
  const thisWeek = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)

  const groupedByDate = {
    today: sessions.filter(s => new Date(s.createdAt) >= today),
    yesterday: sessions.filter(s => {
      const date = new Date(s.createdAt)
      return date >= yesterday && date < today
    }),
    thisWeek: sessions.filter(s => {
      const date = new Date(s.createdAt)
      return date >= thisWeek && date < yesterday
    }),
    older: sessions.filter(s => new Date(s.createdAt) < thisWeek)
  }

  return {
    sessions,
    total: sessions.length,
    groupedByDate
  }
}

/** 按 ID 获取单个会话 */
export async function getSession(id: string): Promise<SessionConfig | null> {
  const sessions = getSessions()
  return sessions.find(s => s.id === id) || null
}

/** 更新会话 */
export async function updateSession(request: SessionUpdateRequest): Promise<SessionConfig> {
  const sessions = getSessions()
  const index = sessions.findIndex(s => s.id === request.id)
  if (index === -1) {
    throw new Error(`Session not found: ${request.id}`)
  }
  const updated: SessionConfig = {
    ...sessions[index],
    ...request,
    updatedAt: new Date().toISOString()
  }
  sessions[index] = updated
  storeSet(SESSIONS_KEY, sessions)
  return updated
}

/** 删除会话及其关联消息 */
export async function deleteSession(id: string): Promise<void> {
  const sessions = getSessions()
  const filtered = sessions.filter(s => s.id !== id)
  storeSet(SESSIONS_KEY, filtered)
  // 同时删除该会话的消息
  const messages = getMessages()
  const filteredMessages = messages.filter(m => m.sessionId !== id)
  storeSet(MESSAGES_KEY, filteredMessages)
}

/** 搜索会话 */
export async function searchSessions(request: SessionSearchRequest): Promise<SessionSearchResponse> {
  const sessions = getSessions()
  const query = request.query.toLowerCase()
  const results = sessions.filter(s =>
    s.title.toLowerCase().includes(query)
  ).slice(0, request.limit || 50)

  return {
    results,
    total: results.length,
    query: request.query
  }
}

/** 导出会话及消息 */
export async function exportSession(id: string): Promise<SessionExportData> {
  const session = await getSession(id)
  if (!session) {
    throw new Error(`Session not found: ${id}`)
  }
  const messages = getMessages().filter(m => m.sessionId === id)
  return {
    session,
    messages,
    exportedAt: new Date().toISOString(),
    version: '1.0.0'
  }
}

/** 导入会话及消息（分配新 ID） */
export async function importSession(data: SessionImportData): Promise<SessionConfig> {
  const sessions = getSessions()
  const now = new Date().toISOString()
  const newSession: SessionConfig = {
    ...data.session,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now
  }
  sessions.push(newSession)
  storeSet(SESSIONS_KEY, sessions)

  // 导入消息，分配新 ID 和会话关联
  const messages = getMessages()
  const newMessages: SessionMessage[] = data.messages.map(m => ({
    ...m,
    id: randomUUID(),
    sessionId: newSession.id,
    timestamp: now
  }))
  messages.push(...newMessages)
  storeSet(MESSAGES_KEY, messages)

  return newSession
}

/** 获取按日期分组的会话 */
export async function getGroupedSessions(): Promise<SessionListResponse['groupedByDate']> {
  const response = await listSessions()
  return response.groupedByDate
}
