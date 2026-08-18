import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import { getIdentity } from '../identity/provider'

/**
 * 身份合并 IPC(2026-08 审计 P1-2)
 *
 * 提供统一身份入口,渲染端通过 window.api.identity.* 访问:
 * - identity.current() → Identity 快照
 * - identity.isOrgSignedIn() → boolean
 * - identity.signOut() → 清空所有身份状态
 * - identity.isSecureStoreAvailable() → boolean
 *
 * 不变量:signOut 后任何 org API 调用必须 401(测试守住)。
 */
export function registerIdentityIpc(): void {
  ipcMain.handle(IpcChannels.identity.current, async () => {
    return getIdentity().current()
  })

  ipcMain.handle(IpcChannels.identity.isOrgSignedIn, async () => {
    return getIdentity().isOrgSignedIn()
  })

  ipcMain.handle(IpcChannels.identity.signOut, async () => {
    await getIdentity().signOut()
    return { ok: true }
  })

  ipcMain.handle(IpcChannels.identity.isSecureStoreAvailable, async () => {
    return getIdentity().isSecureStoreAvailable()
  })
}
