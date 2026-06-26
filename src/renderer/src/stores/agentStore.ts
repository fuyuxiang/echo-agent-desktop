import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { createJSONStorage, persist } from 'zustand/middleware'
import { electronStoreStorage } from './persist-storage'

interface ToolCallEvent {
  id: string
  tool: string
  args: string
  status: 'started' | 'done' | 'error'
  result?: string
  durationMs?: number
  timestamp: number
}

interface AgentState {
  /** 原生 runtime 是否就绪(配置已注入主进程) */
  ready: boolean
  currentSessionKey: string
  toolCalls: ToolCallEvent[]
  retrievedMemories: Array<{ id: string; content: string; tier: string }>
  citations: Array<{ path: string; chunk: string; score: number }>

  /** 兼容旧 Python 时代字段(T11/P6 阶段彻底删除,只读 default 值,不持久化) */
  processStatus: unknown
  connectionMode: 'local' | 'remote'
  baseUrl: string
  wsUrl: string
  remoteUrl: string
  remoteToken: string
  wsConnected: boolean

  setReady: (ready: boolean) => void
  setCurrentSessionKey: (key: string) => void
  addToolCall: (event: ToolCallEvent) => void
  setRetrievedMemories: (entries: AgentState['retrievedMemories']) => void
  setCitations: (citations: AgentState['citations']) => void
  clearExecutionEvents: () => void

  /** 兼容旧 Python 时代调用,T11/P6 阶段彻底删除(只 stub 不报错) */
  setProcessStatus: (status: unknown) => void
  setConnectionMode: (mode: 'local' | 'remote') => void
  setLocalPort: (port: number) => void
  setRemoteConfig: (url: string, token: string) => void
  setWsConnected: (connected: boolean) => void
}

export const useAgentStore = create<AgentState>()(
  persist(
    immer((set) => ({
      ready: false,
      currentSessionKey: '',
      toolCalls: [],
      retrievedMemories: [],
      citations: [],
      // 兼容旧字段(只读 default)
      processStatus: 'stopped',
      connectionMode: 'local',
      baseUrl: '',
      wsUrl: '',
      remoteUrl: '',
      remoteToken: '',
      wsConnected: false,

      setReady: (ready) =>
        set((s) => {
          s.ready = ready
        }),
      setCurrentSessionKey: (key) =>
        set((s) => {
          s.currentSessionKey = key
        }),
      addToolCall: (event) =>
        set((s) => {
          s.toolCalls.push(event)
        }),
      setRetrievedMemories: (entries) =>
        set((s) => {
          s.retrievedMemories = entries
        }),
      setCitations: (citations) =>
        set((s) => {
          s.citations = citations
        }),
      clearExecutionEvents: () =>
        set((s) => {
          s.toolCalls = []
          s.retrievedMemories = []
          s.citations = []
        }),

      // 兼容旧调用,无实际操作。T11 删 ConnectionSection / P6 删 Onboarding 后整体移除
      setProcessStatus: () => {},
      setConnectionMode: () => {},
      setLocalPort: () => {},
      setRemoteConfig: () => {},
      setWsConnected: () => {}
    })),
    {
      name: 'agent',
      version: 2,
      storage: createJSONStorage(() => electronStoreStorage),
      partialize: (s) => ({
        currentSessionKey: s.currentSessionKey
      }),
      // v1 -> v2: 删除远程连接字段,只保留 currentSessionKey
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Record<string, unknown>
        if (version < 2) {
          return { currentSessionKey: (state.currentSessionKey as string) ?? '' }
        }
        return state
      }
    }
  )
)
