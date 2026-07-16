import { create } from 'zustand'
import type {
  GatewayPlatform,
  GatewayConfig,
  GatewayStatus,
  GatewayConfigAddRequest,
  GatewayConfigUpdateRequest,
  GatewayTestResult
} from '@shared/gateway-types'

interface GatewayState {
  platforms: GatewayPlatform[]
  configs: GatewayConfig[]
  statuses: GatewayStatus[]
  loading: boolean
  error: string | null
  fetchPlatforms: () => Promise<void>
  fetchConfigs: () => Promise<void>
  addConfig: (request: GatewayConfigAddRequest) => Promise<void>
  updateConfig: (request: GatewayConfigUpdateRequest) => Promise<void>
  removeConfig: (id: string) => Promise<void>
  testConnection: (platformId: string) => Promise<GatewayTestResult>
}

export const useGatewayStore = create<GatewayState>((set, get) => ({
  platforms: [],
  configs: [],
  statuses: [],
  loading: false,
  error: null,

  fetchPlatforms: async () => {
    set({ loading: true, error: null })
    try {
      const platforms = await window.api.gateway.listPlatforms()
      set({ platforms, loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  fetchConfigs: async () => {
    set({ loading: true, error: null })
    try {
      const result = await window.api.gateway.listConfigs()
      set({
        configs: result.configs,
        statuses: result.statuses,
        loading: false
      })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  addConfig: async (request: GatewayConfigAddRequest) => {
    set({ loading: true, error: null })
    try {
      const newConfig = await window.api.gateway.addConfig(request)
      const configs = [...get().configs, newConfig]
      set({ configs, loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  updateConfig: async (request: GatewayConfigUpdateRequest) => {
    set({ loading: true, error: null })
    try {
      const updatedConfig = await window.api.gateway.updateConfig(request)
      const configs = get().configs.map((c) => (c.id === request.id ? updatedConfig : c))
      set({ configs, loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  removeConfig: async (id: string) => {
    set({ loading: true, error: null })
    try {
      await window.api.gateway.removeConfig(id)
      const configs = get().configs.filter((c) => c.id !== id)
      set({ configs, loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  testConnection: async (platformId: string) => {
    set({ loading: true, error: null })
    try {
      const result = await window.api.gateway.testConnection({ platformId })
      set({ loading: false })
      return result
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
      return { success: false, message: (error as Error).message }
    }
  }
}))
