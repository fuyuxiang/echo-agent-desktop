import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  reasoning?: string
  timestamp: number
  isStreaming?: boolean
}

export interface ChatSession {
  viewKey: string
  key: string
  platform: string
  chatId: string
  lastActivity: string
  messageCount: number
  title?: string
  pinned?: boolean
}

interface ChatState {
  sessions: ChatSession[]
  messages: ChatMessage[]
  currentStreamBuffer: string
  currentReasoningBuffer: string
  isGenerating: boolean
  activeViewKey: string

  setSessions: (sessions: ChatSession[]) => void
  setMessages: (messages: ChatMessage[]) => void
  addSession: (session: ChatSession) => void
  updateSessionTitle: (viewKey: string, title: string) => void
  setActiveViewKey: (viewKey: string) => void
  addUserMessage: (content: string) => void
  startAssistantMessage: () => void
  appendStreamDelta: (delta: string) => void
  appendReasoningDelta: (delta: string) => void
  finalizeAssistantMessage: (fullContent: string) => void
  setIsGenerating: (generating: boolean) => void
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
    activeViewKey: '',

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
    updateSessionTitle: (viewKey, title) =>
      set((s) => {
        const target = s.sessions.find((item) => item.viewKey === viewKey)
        if (target) target.title = title
      }),
    setActiveViewKey: (viewKey) =>
      set((s) => {
        s.activeViewKey = viewKey
      }),

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
    clearMessages: () =>
      set((s) => {
        s.messages = []
        s.currentStreamBuffer = ''
        s.currentReasoningBuffer = ''
      })
  }))
)
