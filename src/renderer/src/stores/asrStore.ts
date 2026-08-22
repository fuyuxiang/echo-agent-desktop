import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import {
  clearASRConfig as clearASRConfigService,
  getASRConfig as getASRConfigService,
  isASRConfigured,
  saveASRConfig as saveASRConfigService,
  type ASRConfigDTO
} from '@/services/asr-config'

interface ASRState {
  /** 当前配置(ref 指针形态);undefined = 未配置 */
  config: ASRConfigDTO | undefined
  /** 启动时是否已尝试加载 */
  loaded: boolean
  /** 是否正在保存 */
  saving: boolean

  loadConfig: () => Promise<void>
  saveConfig: (cfg: ASRConfigInput) => Promise<void>
  clearConfig: () => Promise<void>
}

export interface ASRConfigInput {
  baseUrl: string
  model: string
  apiKey?: string
}

export const useASRStore = create<ASRState>()(
  immer((set) => ({
    config: undefined,
    loaded: false,
    saving: false,

    loadConfig: async () => {
      const cfg = await getASRConfigService()
      set((s) => {
        s.config = cfg
        s.loaded = true
      })
    },

    saveConfig: async (cfg) => {
      set((s) => {
        s.saving = true
      })
      try {
        await saveASRConfigService(cfg)
        // 保存后重新读取,以拿到主进程构造的 apiKeyRef
        const persisted = await getASRConfigService()
        set((s) => {
          s.config = persisted
        })
      } finally {
        set((s) => {
          s.saving = false
        })
      }
    },

    clearConfig: async () => {
      await clearASRConfigService()
      set((s) => {
        s.config = undefined
      })
    }
}))
)

/** 便捷选择器 */
export const selectIsASRConfigured = (s: ASRState): boolean => isASRConfigured(s.config)