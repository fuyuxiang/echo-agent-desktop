import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import type { UserInfo } from '@shared/types'
import { storage } from '@/utils/storage'
import { electronStoreStorage } from './persist-storage'

/**
 * 用户状态
 *
 * - userInfo 走 persist 持久化(electron-store)
 * - token 属敏感信息,不进 persist,统一走 storage.secure(系统级加密)
 *
 * 用法:
 *   const user = useUserStore((s) => s.userInfo)
 *   await useUserStore.getState().login(userInfo, token)
 */
interface UserState {
  /** 当前用户信息,未登录为 null */
  userInfo: UserInfo | null
  /** 是否已登录 */
  isLoggedIn: () => boolean
  /** 登录:保存用户信息 + 加密保存 token */
  login: (userInfo: UserInfo, token: string) => Promise<void>
  /** 登出:清空用户信息与 token */
  logout: () => Promise<void>
  /** 更新用户信息(局部) */
  updateUserInfo: (patch: Partial<UserInfo>) => void
}

export const useUserStore = create<UserState>()(
  persist(
    immer((set, get) => ({
      userInfo: null,

      isLoggedIn: () => get().userInfo !== null,

      login: async (userInfo, token) => {
        await storage.secure.set('token', token)
        set((state) => {
          state.userInfo = userInfo
        })
      },

      logout: async () => {
        await storage.secure.remove('token')
        set((state) => {
          state.userInfo = null
        })
      },

      updateUserInfo: (patch) =>
        set((state) => {
          if (state.userInfo) Object.assign(state.userInfo, patch)
        })
    })),
    {
      name: 'user',
      storage: createJSONStorage(() => electronStoreStorage),
      // 只持久化用户信息,方法不入库
      partialize: (state) => ({ userInfo: state.userInfo }) as UserState
    }
  )
)
