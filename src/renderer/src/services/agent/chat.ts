import { agentRequest } from './proxy-request'
import { AgentApiUrls } from '@/request/urls'
import { useAgentStore } from '@/stores/agentStore'
import type { ChatMessage } from '@/stores/chatStore'

function getBaseUrl(): string {
  return useAgentStore.getState().baseUrl
}

export interface Session {
  session_key: string
  platform: string
  chat_id: string
  last_activity: string
  message_count: number
}

interface RawMessage {
  id?: string
  role?: string
  message_role?: string
  type?: string
  content?: string
  text?: string
  message?: string
  reasoning?: string
  thinking?: string
  thought?: string
  process?: string
  created_at?: string | number
  timestamp?: string | number
  is_streaming?: boolean
}

function toTimestamp(value: string | number | undefined): number {
  if (typeof value === 'number') return value
  if (!value) return Date.now()
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? Date.now() : parsed
}

function normalizeMessages(data: unknown): ChatMessage[] {
  const source = Array.isArray(data)
    ? data
    : Array.isArray((data as { messages?: unknown[] })?.messages)
      ? (data as { messages: unknown[] }).messages
      : []

  return source
    .map<ChatMessage | null>((item, index) => {
      const raw = item as RawMessage
      const role = raw.role ?? raw.message_role ?? raw.type
      if (role !== 'user' && role !== 'assistant' && role !== 'system') return null

      const message: ChatMessage = {
        id: raw.id ?? `${role}-${index}-${toTimestamp(raw.timestamp ?? raw.created_at)}`,
        role,
        content: raw.content ?? raw.text ?? raw.message ?? '',
        reasoning: raw.reasoning ?? raw.thinking ?? raw.thought ?? raw.process,
        timestamp: toTimestamp(raw.timestamp ?? raw.created_at)
      }
      if (raw.is_streaming !== undefined) message.isStreaming = raw.is_streaming
      return message
    })
    .filter((message): message is ChatMessage => Boolean(message))
}

export const chatAPI = {
  getSessions: () =>
    agentRequest
      .get<{ sessions: Session[] }>(`${getBaseUrl()}${AgentApiUrls.sessions}`)
      .then((r) => r.data),

  getSessionMessages: async (key: string): Promise<ChatMessage[]> => {
    const baseUrl = getBaseUrl()
    const endpoints = [AgentApiUrls.sessionMessages(key), AgentApiUrls.sessionDetail(key)]

    for (const endpoint of endpoints) {
      try {
        const resp = await agentRequest.get<unknown>(`${baseUrl}${endpoint}`)
        const messages = normalizeMessages(resp.data)
        if (messages.length > 0 || endpoint === endpoints[endpoints.length - 1]) return messages
      } catch {
        // Some runtime versions only expose the session list. Try the next compatible endpoint.
      }
    }

    return []
  },

  deleteSession: (key: string) =>
    agentRequest.delete(`${getBaseUrl()}${AgentApiUrls.sessionDelete(key)}`).then((r) => r.data),

  sendMessage: (text: string, opts?: { wait?: boolean }) =>
    agentRequest
      .post(`${getBaseUrl()}${AgentApiUrls.message}`, {
        platform: 'desktop',
        user_id: 'local-user',
        chat_id: useAgentStore.getState().currentSessionKey,
        text,
        wait: opts?.wait ?? false
      })
      .then((r) => r.data)
}
