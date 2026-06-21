import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useChatStore, type ChatSession } from '@/stores/chatStore'
import { useAgentStore } from '@/stores/agentStore'
import { agentWs } from '@/services/agent/ws'
import { chatAPI, type Session } from '@/services/agent/chat'
import { toast } from '@/components/Toast'
import { ROUTES } from '@/constants'

function getSessionViewKey(session: Session, index: number): string {
  return [
    session.session_key || 'empty-session-key',
    session.chat_id || 'empty-chat-id',
    session.platform || 'empty-platform',
    session.last_activity || 'empty-last-activity',
    index
  ].join('::')
}

function toChatSessions(
  rawSessions: Session[],
  deletedViewKeys: ReadonlySet<string>
): ChatSession[] {
  return rawSessions
    .map((s, index) => ({
      viewKey: getSessionViewKey(s, index),
      key: s.session_key,
      platform: s.platform,
      chatId: s.chat_id,
      lastActivity: s.last_activity,
      messageCount: s.message_count
    }))
    .filter((s) => !deletedViewKeys.has(s.viewKey))
}

export interface SessionActions {
  handleNewSession: () => void
}

export function useSessionActions(): SessionActions {
  const setCurrentSessionKey = useAgentStore((s) => s.setCurrentSessionKey)
  const clearMessages = useChatStore((s) => s.clearMessages)
  const clearExecutionEvents = useAgentStore((s) => s.clearExecutionEvents)
  const addSession = useChatStore((s) => s.addSession)
  const setActiveViewKey = useChatStore((s) => s.setActiveViewKey)
  const navigate = useNavigate()
  const location = useLocation()

  const handleNewSession = useCallback((): void => {
    const viewKey = `local-${Date.now()}`
    addSession({
      viewKey,
      key: '',
      platform: '',
      chatId: '',
      lastActivity: new Date().toISOString(),
      messageCount: 0,
      title: '新对话'
    })
    setActiveViewKey(viewKey)
    setCurrentSessionKey('')
    clearMessages()
    clearExecutionEvents()
    agentWs.switchSession('default')
    if (!location.pathname.startsWith(ROUTES.chat)) {
      navigate(ROUTES.chat)
    }
  }, [
    addSession,
    setActiveViewKey,
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
  activeSessionViewKey: string
  selectingViewKey: string
  deletingViewKey: string
  handleNewSession: () => void
  handleSelectSession: (session: ChatSession) => Promise<void>
  handleDeleteSession: (session: ChatSession, e: React.MouseEvent) => Promise<void>
}

export function useSessionManager(): SessionManager {
  const sessions = useChatStore((s) => s.sessions)
  const setSessions = useChatStore((s) => s.setSessions)
  const setMessages = useChatStore((s) => s.setMessages)
  const clearMessages = useChatStore((s) => s.clearMessages)
  const activeSessionViewKey = useChatStore((s) => s.activeViewKey)
  const setActiveSessionViewKey = useChatStore((s) => s.setActiveViewKey)
  const wsConnected = useAgentStore((s) => s.wsConnected)
  const currentSessionKey = useAgentStore((s) => s.currentSessionKey)
  const setCurrentSessionKey = useAgentStore((s) => s.setCurrentSessionKey)
  const clearExecutionEvents = useAgentStore((s) => s.clearExecutionEvents)

  const navigate = useNavigate()
  const location = useLocation()

  const [selectingViewKey, setSelectingViewKey] = useState('')
  const [deletingViewKey, setDeletingViewKey] = useState('')
  const deletedSessionViewKeysRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    chatAPI
      .getSessions()
      .then((data) => setSessions(toChatSessions(data.sessions, deletedSessionViewKeysRef.current)))
      .catch(() => {})
  }, [wsConnected, setSessions])

  const reloadSessions = useCallback(
    async (deletedViewKeys = deletedSessionViewKeysRef.current): Promise<void> => {
      const data = await chatAPI.getSessions()
      setSessions(toChatSessions(data.sessions, deletedViewKeys))
    },
    [setSessions]
  )

  const handleNewSession = useCallback((): void => {
    const viewKey = `local-${Date.now()}`
    useChatStore.getState().addSession({
      viewKey,
      key: '',
      platform: '',
      chatId: '',
      lastActivity: new Date().toISOString(),
      messageCount: 0,
      title: '新对话'
    })
    setActiveSessionViewKey(viewKey)
    setCurrentSessionKey('')
    clearMessages()
    clearExecutionEvents()
    agentWs.switchSession('default')
    if (!location.pathname.startsWith(ROUTES.chat)) {
      navigate(ROUTES.chat)
    }
  }, [
    setActiveSessionViewKey,
    setCurrentSessionKey,
    clearMessages,
    clearExecutionEvents,
    navigate,
    location.pathname
  ])

  const handleSelectSession = async (session: ChatSession): Promise<void> => {
    const isActive = activeSessionViewKey
      ? session.viewKey === activeSessionViewKey
      : session.key === currentSessionKey
    if (selectingViewKey || isActive) return

    if (!session.key) {
      toast.error('该会话缺少运行时标识，无法打开')
      return
    }

    setSelectingViewKey(session.viewKey)
    try {
      setActiveSessionViewKey(session.viewKey)
      setCurrentSessionKey(session.key)
      clearMessages()
      clearExecutionEvents()
      agentWs.switchSession(session.key)

      if (!location.pathname.startsWith(ROUTES.chat)) {
        navigate(ROUTES.chat)
      }

      const history = await chatAPI.getSessionMessages(session.key)
      setMessages(
        history.length > 0
          ? history
          : [
              {
                id: `system-session-${session.viewKey}`,
                role: 'system',
                content:
                  '已切换到该会话。该会话暂无可展示的历史消息，继续发送消息会沿用这个会话上下文。',
                timestamp: 0
              }
            ]
      )
      if (history.length === 0) {
        toast.info('已切换会话；暂无可展示的历史消息')
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      toast.error(`打开会话失败：${message}`)
    } finally {
      setSelectingViewKey('')
    }
  }

  const handleDeleteSession = async (session: ChatSession, e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (deletingViewKey) return

    setDeletingViewKey(session.viewKey)
    try {
      const duplicateRuntimeKey =
        session.key && sessions.filter((item) => item.key === session.key).length > 1
      const canDeleteInRuntime = Boolean(session.key) && !duplicateRuntimeKey

      if (canDeleteInRuntime) {
        await chatAPI.deleteSession(session.key)
      }

      const nextDeletedViewKeys = new Set(deletedSessionViewKeysRef.current)
      nextDeletedViewKeys.add(session.viewKey)
      deletedSessionViewKeysRef.current = nextDeletedViewKeys
      setSessions(
        useChatStore.getState().sessions.filter((item) => item.viewKey !== session.viewKey)
      )

      const isDeletingActiveSession = activeSessionViewKey
        ? activeSessionViewKey === session.viewKey
        : currentSessionKey === session.key
      if (isDeletingActiveSession) {
        setActiveSessionViewKey('')
        setCurrentSessionKey('')
        clearMessages()
        clearExecutionEvents()
        agentWs.switchSession('default')
      }

      try {
        await reloadSessions(nextDeletedViewKeys)
      } catch {
        // local list already updated
      }

      toast.success(canDeleteInRuntime ? '会话已删除' : '已从当前列表移除')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(`删除会话失败：${message}`)
    } finally {
      setDeletingViewKey('')
    }
  }

  return {
    sessions,
    activeSessionViewKey,
    selectingViewKey,
    deletingViewKey,
    handleNewSession,
    handleSelectSession,
    handleDeleteSession
  }
}
