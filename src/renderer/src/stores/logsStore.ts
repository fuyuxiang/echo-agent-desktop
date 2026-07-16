import { create } from 'zustand'
import type { LogEntry, LogQueryRequest } from '@shared/settings-types'

interface LogsState {
  logs: LogEntry[]
  loading: boolean
  error: string | null
  fetchLogs: (request?: LogQueryRequest) => Promise<void>
  clearLogs: () => Promise<void>
}

export const useLogsStore = create<LogsState>((set) => ({
  logs: [],
  loading: false,
  error: null,

  fetchLogs: async (request?: LogQueryRequest) => {
    set({ loading: true, error: null })
    try {
      const result = await window.api.logs.list(request)
      set({ logs: result.logs, loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  clearLogs: async () => {
    set({ loading: true, error: null })
    try {
      await window.api.logs.clear()
      set({ logs: [], loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  }
}))
