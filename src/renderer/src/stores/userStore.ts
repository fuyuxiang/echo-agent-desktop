import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import type { UserInfo } from '@shared/types'
import { storage } from '@/utils'
import { login as apiLogin, type ServerUser } from '@/services/server'
import { electronStoreStorage } from './persist-storage'

/**
 * 用户状态
 *
 * - userInfo / user 走 persist 持久化(electron-store)
 * - token 属敏感信息,不进 persist,统一走 storage.secure(系统级加密)
 *
 * 用法:
 *   const user = useUserStore((s) => s.user)
 *   await useUserStore.getState().signIn(username, password)
 */
interface UserState {
  /** 服务端账号信息,未登录为 null(登录态以此为准) */
  user: ServerUser | null
  /** 是否已登录(派生字段,随 signIn/signOut 同步) */
  isAuthed: boolean
  /** 登录:调用服务端 login,token 加密落盘,user 入 store */
  signIn: (username: string, password: string) => Promise<void>
  /** 登出:清空 token 与登录态 */
  signOut: () => void

  /** 本地用户信息(基建保留字段,未登录为 null) */
  userInfo: UserInfo | null
  /** 是否已登录(兼容旧调用) */
  isLoggedIn: () => boolean
  /** 设置本地用户信息 + 加密保存 token(兼容旧调用) */
  login: (userInfo: UserInfo, token: string) => Promise<void>
  /** 清空本地用户信息与 token(兼容旧调用) */
  logout: () => Promise<void>
  /** 更新本地用户信息(局部) */
  updateUserInfo: (patch: Partial<UserInfo>) => void
}

export const useUserStore = create<UserState>()(
  persist(
    immer((set, get) => ({
      user: null,
      isAuthed: false,

      signIn: async (username, password) => {
        const { token, user } = await apiLogin(username, password)
        await storage.secure.set('token', token)
        set((state) => {
          state.user = user
          state.isAuthed = true
        })
      },

      signOut: () => {
        storage.secure.remove('token')
        set((state) => {
          state.user = null
          state.isAuthed = false
        })
      },

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
      // 只持久化用户信息与登录态,方法不入库
      partialize: (state) =>
        ({ user: state.user, isAuthed: state.isAuthed, userInfo: state.userInfo }) as UserState
    }
  )
)
