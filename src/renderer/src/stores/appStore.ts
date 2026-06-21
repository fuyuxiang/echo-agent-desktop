import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import type { AppSettings } from '@shared/types'
import { electronStoreStorage } from './persist-storage'

/**
 * 应用全局状态(主题/语言/通用设置)
 *
 * 用法:
 *   const theme = useAppStore((s) => s.settings.theme)
 *   useAppStore.getState().setTheme('dark')
 */
interface AppState {
  /** 应用设置(持久化) */
  settings: AppSettings
  /** 设置主题 */
  setTheme: (theme: AppSettings['theme']) => void
  /** 设置语言 */
  setLanguage: (language: AppSettings['language']) => void
  /** 设置开机自启标记(实际系统行为请配合 utils/permission.setLaunchAtLogin) */
  setLaunchAtLogin: (enable: boolean) => void
}

export const useAppStore = create<AppState>()(
  persist(
    immer((set) => ({
      settings: {
        language: 'zh-CN',
        theme: 'system',
        launchAtLogin: false
      },

      setTheme: (theme) =>
        set((state) => {
          state.settings.theme = theme
        }),

      setLanguage: (language) =>
        set((state) => {
          state.settings.language = language
        }),

      setLaunchAtLogin: (enable) =>
        set((state) => {
          state.settings.launchAtLogin = enable
        })
    })),
    {
      name: 'app',
      storage: createJSONStorage(() => electronStoreStorage)
    }
  )
)
