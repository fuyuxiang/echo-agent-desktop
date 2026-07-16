import { create } from 'zustand'
import type { SoulConfig, SoulAddRequest, SoulUpdateRequest } from '@shared/soul-types'

interface SoulState {
  souls: SoulConfig[]
  activeSoul: SoulConfig | null
  loading: boolean
  error: string | null
  fetchSouls: () => Promise<void>
  addSoul: (request: SoulAddRequest) => Promise<void>
  updateSoul: (request: SoulUpdateRequest) => Promise<void>
  deleteSoul: (id: string) => Promise<void>
  setActiveSoul: (id: string) => Promise<void>
}

export const useSoulStore = create<SoulState>((set, get) => ({
  souls: [],
  activeSoul: null,
  loading: false,
  error: null,

  fetchSouls: async () => {
    set({ loading: true, error: null })
    try {
      const result = await window.api.soul.list()
      const activeSoul = result.souls.find((s) => s.isActive) || null
      set({ souls: result.souls, activeSoul, loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  addSoul: async (request: SoulAddRequest) => {
    set({ loading: true, error: null })
    try {
      const newSoul = await window.api.soul.add(request)
      const souls = [...get().souls, newSoul]
      set({ souls, loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  updateSoul: async (request: SoulUpdateRequest) => {
    set({ loading: true, error: null })
    try {
      const updatedSoul = await window.api.soul.update(request)
      const souls = get().souls.map((s) => (s.id === request.id ? updatedSoul : s))
      const activeSoul = updatedSoul.isActive ? updatedSoul : get().activeSoul
      set({ souls, activeSoul, loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  deleteSoul: async (id: string) => {
    set({ loading: true, error: null })
    try {
      await window.api.soul.delete(id)
      const souls = get().souls.filter((s) => s.id !== id)
      const activeSoul = get().activeSoul?.id === id ? null : get().activeSoul
      set({ souls, activeSoul, loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  setActiveSoul: async (id: string) => {
    set({ loading: true, error: null })
    try {
      await window.api.soul.setActive(id)
      const souls = get().souls.map((s) => ({ ...s, isActive: s.id === id }))
      const activeSoul = souls.find((s) => s.id === id) || null
      set({ souls, activeSoul, loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  }
}))
