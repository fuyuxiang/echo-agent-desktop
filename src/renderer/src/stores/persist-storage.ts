import type { StateStorage } from 'zustand/middleware'
import { storage } from '@/utils/storage'

/**
 * zustand persist 的自定义存储适配器
 *
 * 持久化唯一落点约定: 不用 localStorage,统一对接 electron-store,
 * 保证全项目只有一个落盘出口(userData/config.json)
 */
export const electronStoreStorage: StateStorage = {
  getItem: async (name) => {
    const value = await storage.get<string>(`zustand.${name}`)
    return value ?? null
  },
  setItem: async (name, value) => {
    await storage.set(`zustand.${name}`, value)
  },
  removeItem: async (name) => {
    await storage.remove(`zustand.${name}`)
  }
}
