import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { createJSONStorage, persist } from 'zustand/middleware'
import { electronStoreStorage } from './persist-storage'
import type { AgentProcessStatus } from '@shared/types'

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
  processStatus: AgentProcessStatus
  connectionMode: 'local' | 'remote'
  baseUrl: string
  wsUrl: string
  remoteUrl: string
  remoteToken: string
  currentSessionKey: string
  wsConnected: boolean
  toolCalls: ToolCallEvent[]
  retrievedMemories: Array<{ id: string; content: string; tier: string }>
  citations: Array<{ path: string; chunk: string; score: number }>

  setProcessStatus: (status: AgentProcessStatus) => void
  setConnectionMode: (mode: 'local' | 'remote') => void
  setLocalPort: (port: number) => void
  setRemoteConfig: (url: string, token: string) => void
  setCurrentSessionKey: (key: string) => void
  setWsConnected: (connected: boolean) => void
  addToolCall: (event: ToolCallEvent) => void
  setRetrievedMemories: (entries: AgentState['retrievedMemories']) => void
  setCitations: (citations: AgentState['citations']) => void
  clearExecutionEvents: () => void
}

export const useAgentStore = create<AgentState>()(
  persist(
    immer((set) => ({
      processStatus: 'stopped',
      connectionMode: 'local',
      baseUrl: 'http://127.0.0.1:9000',
      wsUrl: 'ws://127.0.0.1:9000/ws',
      remoteUrl: '',
      remoteToken: '',
      currentSessionKey: '',
      wsConnected: false,
      toolCalls: [],
      retrievedMemories: [],
      citations: [],

      setProcessStatus: (status) =>
        set((s) => {
          s.processStatus = status
        }),
      setConnectionMode: (mode) =>
        set((s) => {
          s.connectionMode = mode
        }),
      setLocalPort: (port) =>
        set((s) => {
          s.baseUrl = `http://127.0.0.1:${port}`
          s.wsUrl = `ws://127.0.0.1:${port}/ws`
        }),
      setRemoteConfig: (url, token) =>
        set((s) => {
          s.remoteUrl = url
          s.remoteToken = token
          if (s.connectionMode === 'remote') {
            s.baseUrl = url
            s.wsUrl = url.replace(/^http/, 'ws') + '/ws'
          }
        }),
      setCurrentSessionKey: (key) =>
        set((s) => {
          s.currentSessionKey = key
        }),
      setWsConnected: (connected) =>
        set((s) => {
          s.wsConnected = connected
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
        })
    })),
    {
      name: 'agent',
      storage: createJSONStorage(() => electronStoreStorage),
      partialize: (s) => ({
        connectionMode: s.connectionMode,
        remoteUrl: s.remoteUrl,
        remoteToken: s.remoteToken,
        currentSessionKey: s.currentSessionKey
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return
        if (state.connectionMode === 'remote' && state.remoteUrl) {
          state.baseUrl = state.remoteUrl
          state.wsUrl = state.remoteUrl.replace(/^http/, 'ws') + '/ws'
        }
      }
    }
  )
)
