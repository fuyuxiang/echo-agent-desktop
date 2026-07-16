import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import type { SettingsConfig, ThemeMode, NetworkConfig } from '@shared/settings-types'
import { electronStoreStorage } from './persist-storage'

interface SettingsState {
  settings: SettingsConfig | null
  loading: boolean
  error: string | null
  fetchSettings: () => Promise<void>
  updateSettings: (request: Partial<Omit<SettingsConfig, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<void>
  setTheme: (theme: ThemeMode) => void
  setLanguage: (language: string) => void
  setNetwork: (network: NetworkConfig) => void
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    immer((set, get) => ({
      settings: null,
      loading: false,
      error: null,

      fetchSettings: async () => {
        set({ loading: true, error: null })
        try {
          const settings = await window.api.settings.get()
          set({ settings, loading: false })
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error), loading: false })
        }
      },

      updateSettings: async (request) => {
        const currentId = get().settings?.id
        if (!currentId) return
        set({ loading: true, error: null })
        try {
          const settings = await window.api.settings.update({ id: currentId, ...request })
          set({ settings, loading: false })
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error), loading: false })
        }
      },

      setTheme: (theme) =>
        set((state) => {
          if (state.settings) {
            state.settings.theme = theme
          }
        }),

      setLanguage: (language) =>
        set((state) => {
          if (state.settings) {
            state.settings.language = language
          }
        }),

      setNetwork: (network) =>
        set((state) => {
          if (state.settings) {
            state.settings.network = network
          }
        })
    })),
    {
      name: 'settings',
      storage: createJSONStorage(() => electronStoreStorage)
    }
  )
)
