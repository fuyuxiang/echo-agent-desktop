import { create } from 'zustand'
import type {
  ProviderConfig,
  ProviderAddRequest,
  ProviderUpdateRequest,
  ProviderTestResult
} from '@shared/provider-types'

interface ProviderState {
  providers: ProviderConfig[]
  loading: boolean
  error: string | null
  fetchProviders: () => Promise<void>
  addProvider: (request: ProviderAddRequest) => Promise<void>
  updateProvider: (request: ProviderUpdateRequest) => Promise<void>
  removeProvider: (id: string) => Promise<void>
  testProvider: (id: string) => Promise<ProviderTestResult>
}

export const useProviderStore = create<ProviderState>()((set, get) => ({
  providers: [],
  loading: false,
  error: null,

  fetchProviders: async () => {
    set({ loading: true, error: null })
    try {
      const result = await window.api.providers.list()
      set({ providers: result.providers, loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  addProvider: async (request) => {
    set({ loading: true, error: null })
    try {
      const newProvider = await window.api.providers.add(request)
      const providers = [...get().providers, newProvider]
      set({ providers, loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  updateProvider: async (request) => {
    set({ loading: true, error: null })
    try {
      const updatedProvider = await window.api.providers.update(request)
      const providers = get().providers.map((p) => (p.id === request.id ? updatedProvider : p))
      set({ providers, loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  removeProvider: async (id) => {
    set({ loading: true, error: null })
    try {
      await window.api.providers.remove(id)
      const providers = get().providers.filter((p) => p.id !== id)
      set({ providers, loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  testProvider: async (id) => {
    set({ loading: true, error: null })
    try {
      const result = await window.api.providers.test({ id })
      set({ loading: false })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message, loading: false })
      return { success: false, message }
    }
  }
}))
