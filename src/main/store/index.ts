import { safeStorage } from 'electron'
import Store from 'electron-store'
import { log } from '../logger'

/**
 * 本地 KV 存储(electron-store)
 *
 * - 落盘位置: userData/config.json
 * - 渲染层通过 utils/storage.ts 门面读写,不直接接触此模块
 * - 敏感数据(token 等)走 secureSet/secureGet,使用系统级加密(mac Keychain / win DPAPI)
 */
const store = new Store({
  name: 'config',
  // 防止用户手改配置文件导致 JSON 损坏崩溃
  clearInvalidConfig: true
})

/** 加密数据统一存放的命名空间,与普通配置隔离 */
const SECURE_PREFIX = '__secure__.'

/** 读取配置项 */
export function storeGet<T = unknown>(key: string): T | undefined {
  return store.get(key) as T | undefined
}

/** 写入配置项 */
export function storeSet(key: string, value: unknown): void {
  store.set(key, value)
}

/** 删除配置项 */
export function storeDelete(key: string): void {
  store.delete(key)
}

/** 清空全部配置(含加密数据) */
export function storeClear(): void {
  store.clear()
}

/**
 * 写入加密配置(safeStorage 系统级加密后以 base64 落盘)
 * 加密不可用时(极少数 Linux 环境)降级为明文并告警
 */
export function secureSet(key: string, value: string): void {
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(value).toString('base64')
    store.set(SECURE_PREFIX + key, { encrypted: true, value: encrypted })
  } else {
    log.warn('[store] safeStorage 不可用,敏感数据降级为明文存储:', key)
    store.set(SECURE_PREFIX + key, { encrypted: false, value })
  }
}

/** 读取加密配置(自动解密) */
export function secureGet(key: string): string | undefined {
  const record = store.get(SECURE_PREFIX + key) as { encrypted: boolean; value: string } | undefined
  if (!record) return undefined
  if (!record.encrypted) return record.value
  try {
    return safeStorage.decryptString(Buffer.from(record.value, 'base64'))
  } catch (err) {
    log.error('[store] 解密失败(可能换了系统账户):', key, err)
    return undefined
  }
}

/** 删除加密配置 */
export function secureDelete(key: string): void {
  store.delete(SECURE_PREFIX + key)
}
