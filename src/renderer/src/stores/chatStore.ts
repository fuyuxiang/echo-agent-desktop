import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { db } from '@/utils/db'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  reasoning?: string
  timestamp: number
  isStreaming?: boolean
}

export interface ChatSession {
  /** 本地主键,也是发给服务端 WS 的 chat_id(uuid) */
  chatId: string
  title?: string
  platform: string
  lastActivity: number
  messageCount: number
  pinned?: boolean
}

interface ChatState {
  sessions: ChatSession[]
  messages: ChatMessage[]
  currentStreamBuffer: string
  currentReasoningBuffer: string
  isGenerating: boolean
  activeChatId: string
  /** 兜底重发用:待补发的首条消息(供后续任务衔接) */
  pendingPrimer: string

  setSessions: (sessions: ChatSession[]) => void
  setMessages: (messages: ChatMessage[]) => void
  addSession: (session: ChatSession) => void
  updateSessionTitle: (chatId: string, title: string) => void
  setActiveChatId: (chatId: string) => void
  setPendingPrimer: (primer: string) => void
  loadSessionsFromLocal: () => Promise<void>
  loadMessagesFromLocal: (chatId: string) => Promise<void>
  addUserMessage: (content: string) => void
  startAssistantMessage: () => void
  appendStreamDelta: (delta: string) => void
  appendReasoningDelta: (delta: string) => void
  finalizeAssistantMessage: (fullContent: string) => void
  setIsGenerating: (generating: boolean) => void
  /** 前端侧停止生成:定格当前流式消息并结束生成态(后端那次推理可能仍在跑) */
  stopGenerating: () => void
  /** 删除最后一条 assistant 消息(用于重新生成) */
  removeLastAssistant: () => void
  clearMessages: () => void
}

let messageIdCounter = 0

function normalizeComparableText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function deriveReasoningFromStream(streamed: string, finalContent: string): string {
  const stream = streamed.trim()
  const final = finalContent.trim()
  if (!stream || !final) return ''

  const comparableStream = normalizeComparableText(stream)
  const comparableFinal = normalizeComparableText(final)
  if (comparableStream === comparableFinal || comparableFinal.includes(comparableStream)) return ''

  if (stream.includes(final)) {
    return stream.replace(final, '').trim()
  }

  return stream
}

export const useChatStore = create<ChatState>()(
  immer((set) => ({
    sessions: [],
    messages: [],
    currentStreamBuffer: '',
    currentReasoningBuffer: '',
    isGenerating: false,
    activeChatId: '',
    pendingPrimer: '',

    setSessions: (sessions) =>
      set((s) => {
        s.sessions = sessions
      }),
    setMessages: (messages) =>
      set((s) => {
        s.messages = messages
      }),
    addSession: (session) =>
      set((s) => {
        s.sessions.unshift(session)
      }),
    updateSessionTitle: (chatId, title) =>
      set((s) => {
        const target = s.sessions.find((item) => item.chatId === chatId)
        if (target) target.title = title
      }),
    setActiveChatId: (chatId) =>
      set((s) => {
        s.activeChatId = chatId
      }),
    setPendingPrimer: (primer) =>
      set((s) => {
        s.pendingPrimer = primer
      }),

    loadSessionsFromLocal: async () => {
      const rows = await db.session.list()
      set((s) => {
        s.sessions = rows.map((r) => ({
          chatId: r.chatId,
          title: r.title ?? undefined,
          platform: r.platform,
          lastActivity: r.lastActivity,
          messageCount: r.messageCount,
          pinned: r.pinned === 1
        }))
      })
    },

    loadMessagesFromLocal: async (chatId) => {
      const rows = await db.session.getMessages(chatId)
      set((s) => {
        s.messages = rows.map((r) => ({
          id: `m-${r.id}`,
          role: r.role as ChatMessage['role'],
          content: r.content,
          reasoning: r.reasoning ?? undefined,
          timestamp: r.createdAt
        }))
        s.currentStreamBuffer = ''
        s.currentReasoningBuffer = ''
      })
    },

    addUserMessage: (content) =>
      set((s) => {
        s.messages.push({
          id: `user-${++messageIdCounter}`,
          role: 'user',
          content,
          timestamp: Date.now()
        })
      }),

    startAssistantMessage: () =>
      set((s) => {
        s.currentStreamBuffer = ''
        s.currentReasoningBuffer = ''
        s.isGenerating = true
        s.messages.push({
          id: `assistant-${++messageIdCounter}`,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          isStreaming: true
        })
      }),

    appendStreamDelta: (delta) =>
      set((s) => {
        s.currentStreamBuffer += delta
        const last = s.messages[s.messages.length - 1]
        if (last?.isStreaming) {
          last.content = s.currentStreamBuffer
        }
      }),

    appendReasoningDelta: (delta) =>
      set((s) => {
        s.currentReasoningBuffer += delta
        const last = s.messages[s.messages.length - 1]
        if (last?.isStreaming) {
          last.reasoning = s.currentReasoningBuffer
        }
      }),

    finalizeAssistantMessage: (fullContent) =>
      set((s) => {
        const last = s.messages[s.messages.length - 1]
        if (last?.isStreaming) {
          const resolvedContent = fullContent.trim() ? fullContent : s.currentStreamBuffer
          const derivedReasoning = deriveReasoningFromStream(s.currentStreamBuffer, resolvedContent)
          const reasoning = [s.currentReasoningBuffer, derivedReasoning]
            .map((part) => part.trim())
            .filter(Boolean)
            .join('\n\n')
          if (reasoning) last.reasoning = reasoning
          last.content = resolvedContent
          last.isStreaming = false
        }
        s.currentStreamBuffer = ''
        s.currentReasoningBuffer = ''
        s.isGenerating = false
      }),

    setIsGenerating: (generating) =>
      set((s) => {
        s.isGenerating = generating
      }),
    stopGenerating: () =>
      set((s) => {
        const last = s.messages[s.messages.length - 1]
        if (last?.isStreaming) {
          // 定格已收到的内容;若空内容则移除占位气泡
          if (s.currentStreamBuffer.trim()) {
            last.content = s.currentStreamBuffer
            if (s.currentReasoningBuffer.trim()) last.reasoning = s.currentReasoningBuffer
            last.isStreaming = false
          } else {
            s.messages.pop()
          }
        }
        s.currentStreamBuffer = ''
        s.currentReasoningBuffer = ''
        s.isGenerating = false
      }),
    removeLastAssistant: () =>
      set((s) => {
        const idx = [...s.messages].reverse().findIndex((m) => m.role === 'assistant')
        if (idx === -1) return
        s.messages.splice(s.messages.length - 1 - idx, 1)
        s.currentStreamBuffer = ''
        s.currentReasoningBuffer = ''
        s.isGenerating = false
      }),
    clearMessages: () =>
      set((s) => {
        s.messages = []
        s.currentStreamBuffer = ''
        s.currentReasoningBuffer = ''
      })
  }))
)
