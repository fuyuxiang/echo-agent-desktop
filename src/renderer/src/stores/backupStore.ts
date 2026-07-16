import { create } from 'zustand'
import type { BackupConfig, BackupCreateRequest, BackupRestoreRequest } from '@shared/settings-types'

interface BackupState {
  backups: BackupConfig[]
  loading: boolean
  error: string | null
  fetchBackups: () => Promise<void>
  createBackup: (request: BackupCreateRequest) => Promise<void>
  restoreBackup: (request: BackupRestoreRequest) => Promise<void>
  deleteBackup: (id: string) => Promise<void>
}

export const useBackupStore = create<BackupState>((set, get) => ({
  backups: [],
  loading: false,
  error: null,

  fetchBackups: async () => {
    set({ loading: true, error: null })
    try {
      const result = await window.api.invoke('backup:listBackups')
      set({ backups: result.backups, loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  createBackup: async (request: BackupCreateRequest) => {
    set({ loading: true, error: null })
    try {
      const newBackup = await window.api.invoke('backup:createBackup', request)
      const backups = [...get().backups, newBackup]
      set({ backups, loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  restoreBackup: async (request: BackupRestoreRequest) => {
    set({ loading: true, error: null })
    try {
      await window.api.invoke('backup:restoreBackup', request)
      set({ loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  deleteBackup: async (id: string) => {
    set({ loading: true, error: null })
    try {
      await window.api.invoke('backup:deleteBackup', id)
      const backups = get().backups.filter((b) => b.id !== id)
      set({ backups, loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  }
}))
