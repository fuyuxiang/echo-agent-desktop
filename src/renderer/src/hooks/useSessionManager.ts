import { useEffect, useState, useCallback } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useChatStore, type ChatSession } from '@/stores/chatStore'
import { useAgentStore } from '@/stores/agentStore'
import { agentWs } from '@/services/agent/runtime-client'
import { db } from '@/utils/db'
import {
  isSessionStale,
  extractRecentRounds,
  buildPrimerText,
  type SessionMessageLike
} from '@/services/session-history'
import { toast } from '@/components/Toast'
import { ROUTES } from '@/constants'

export interface SessionActions {
  handleNewSession: () => Promise<void>
}

export function useSessionActions(): SessionActions {
  const setCurrentSessionKey = useAgentStore((s) => s.setCurrentSessionKey)
  const clearMessages = useChatStore((s) => s.clearMessages)
  const clearExecutionEvents = useAgentStore((s) => s.clearExecutionEvents)
  const setActiveChatId = useChatStore((s) => s.setActiveChatId)
  const loadSessionsFromLocal = useChatStore((s) => s.loadSessionsFromLocal)
  const navigate = useNavigate()
  const location = useLocation()

  const handleNewSession = useCallback(async (): Promise<void> => {
    const chatId = crypto.randomUUID()
    await db.session.upsert({ chatId, title: '新对话', platform: 'desktop' })
    await loadSessionsFromLocal()
    setActiveChatId(chatId)
    setCurrentSessionKey(chatId)
    clearMessages()
    clearExecutionEvents()
    agentWs.switchSession(chatId)
    if (!location.pathname.startsWith(ROUTES.chat)) {
      navigate(ROUTES.chat)
    }
  }, [
    loadSessionsFromLocal,
    setActiveChatId,
    setCurrentSessionKey,
    clearMessages,
    clearExecutionEvents,
    navigate,
    location.pathname
  ])

  return { handleNewSession }
}

export interface SessionManager {
  sessions: ChatSession[]
  activeChatId: string
  selectingChatId: string
  deletingChatId: string
  handleNewSession: () => Promise<void>
  handleSelectSession: (session: ChatSession) => Promise<void>
  handleDeleteSession: (session: ChatSession, e: React.MouseEvent) => Promise<void>
  handleTogglePin: (session: ChatSession) => Promise<void>
}

export function useSessionManager(): SessionManager {
  const sessions = useChatStore((s) => s.sessions)
  const clearMessages = useChatStore((s) => s.clearMessages)
  const activeChatId = useChatStore((s) => s.activeChatId)
  const setActiveChatId = useChatStore((s) => s.setActiveChatId)
  const loadSessionsFromLocal = useChatStore((s) => s.loadSessionsFromLocal)
  const loadMessagesFromLocal = useChatStore((s) => s.loadMessagesFromLocal)
  const updateSessionPinned = useChatStore((s) => s.updateSessionPinned)
  const wsConnected = useAgentStore((s) => s.ready)
  const setCurrentSessionKey = useAgentStore((s) => s.setCurrentSessionKey)
  const clearExecutionEvents = useAgentStore((s) => s.clearExecutionEvents)

  const navigate = useNavigate()
  const location = useLocation()

  const [selectingChatId, setSelectingChatId] = useState('')
  const [deletingChatId, setDeletingChatId] = useState('')

  useEffect(() => {
    loadSessionsFromLocal().catch(() => {})
  }, [wsConnected, loadSessionsFromLocal])

  const handleNewSession = useCallback(async (): Promise<void> => {
    const chatId = crypto.randomUUID()
    await db.session.upsert({ chatId, title: '新对话', platform: 'desktop' })
    await loadSessionsFromLocal()
    setActiveChatId(chatId)
    setCurrentSessionKey(chatId)
    clearMessages()
    clearExecutionEvents()
    agentWs.switchSession(chatId)
    if (!location.pathname.startsWith(ROUTES.chat)) {
      navigate(ROUTES.chat)
    }
  }, [
    loadSessionsFromLocal,
    setActiveChatId,
    setCurrentSessionKey,
    clearMessages,
    clearExecutionEvents,
    navigate,
    location.pathname
  ])

  const handleSelectSession = async (session: ChatSession): Promise<void> => {
    if (selectingChatId || session.chatId === activeChatId) return

    setSelectingChatId(session.chatId)
    try {
      setActiveChatId(session.chatId)
      setCurrentSessionKey(session.chatId)
      clearExecutionEvents()
      await loadMessagesFromLocal(session.chatId)

      if (isSessionStale(session.lastActivity)) {
        const msgs = useChatStore.getState().messages
        const rounds = extractRecentRounds(
          msgs.map((m) => ({ role: m.role, content: m.content })) as SessionMessageLike[]
        )
        useChatStore.getState().setPendingPrimer(buildPrimerText(rounds))
      } else {
        useChatStore.getState().setPendingPrimer('')
      }

      agentWs.switchSession(session.chatId)
      if (!location.pathname.startsWith(ROUTES.chat)) {
        navigate(ROUTES.chat)
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      toast.error(`打开会话失败：${message}`)
    } finally {
      setSelectingChatId('')
    }
  }

  const handleDeleteSession = async (session: ChatSession, e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (deletingChatId) return

    setDeletingChatId(session.chatId)
    try {
      await db.session.delete(session.chatId)
      // Best-effort cleanup; ignore failures since local is the source of truth.
      window.api.agentChat.deleteSession(session.chatId).catch(() => {})
      await loadSessionsFromLocal()

      if (session.chatId === activeChatId) {
        setActiveChatId('')
        setCurrentSessionKey('')
        clearMessages()
        clearExecutionEvents()
        agentWs.switchSession('default')
      }

      toast.success('会话已删除')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(`删除会话失败：${message}`)
    } finally {
      setDeletingChatId('')
    }
  }

  const handleTogglePin = async (session: ChatSession): Promise<void> => {
    const next = !session.pinned
    // 乐观更新 + 重排;写库失败则回滚
    updateSessionPinned(session.chatId, next)
    try {
      await db.session.setPinned(session.chatId, next)
    } catch (err) {
      updateSessionPinned(session.chatId, !next)
      const message = err instanceof Error ? err.message : String(err)
      toast.error(`${next ? '置顶' : '取消置顶'}失败：${message}`)
    }
  }

  return {
    sessions,
    activeChatId,
    selectingChatId,
    deletingChatId,
    handleNewSession,
    handleSelectSession,
    handleDeleteSession,
    handleTogglePin
  }
}
