/**
 * KV 存储门面(底层 electron-store,主进程落盘)
 *
 * 用法:
 *   await storage.set('lastRoute', '/chat')
 *   const route = await storage.get<string>('lastRoute')
 *   await storage.secure.set('token', 'xxx')   // 敏感数据,系统级加密
 */
export const storage = {
  /** 读取配置项 */
  get<T = unknown>(key: string): Promise<T | undefined> {
    return window.api.store.get<T>(key)
  },

  /** 写入配置项(值需可 JSON 序列化) */
  set(key: string, value: unknown): Promise<void> {
    return window.api.store.set(key, value)
  },

  /** 删除配置项 */
  remove(key: string): Promise<void> {
    return window.api.store.delete(key)
  },

  /** 清空全部配置(慎用) */
  clear(): Promise<void> {
    return window.api.store.clear()
  },

  /** 加密存储(token 等敏感信息专用,mac Keychain / win DPAPI 加密) */
  secure: {
    /** 读取并解密 */
    get(key: string): Promise<string | undefined> {
      return window.api.store.secureGet(key)
    },
    /** 加密并写入 */
    set(key: string, value: string): Promise<void> {
      return window.api.store.secureSet(key, value)
    },
    /** 删除 */
    remove(key: string): Promise<void> {
      return window.api.store.secureDelete(key)
    }
  }
}
