import { ipcMain } from 'electron'
import type { MediaPermissionType } from '@shared/types'
import { IpcChannels } from '@shared/ipc-channels'
import {
  checkMediaPermission,
  getLoginItemEnabled,
  requestMediaPermission,
  setLoginItemEnabled
} from '../permission'

/** 注册系统权限类 IPC */
export function registerPermissionHandlers(): void {
  ipcMain.handle(IpcChannels.permission.check, (_e, type: MediaPermissionType) =>
    checkMediaPermission(type)
  )
  ipcMain.handle(IpcChannels.permission.request, (_e, type: MediaPermissionType) =>
    requestMediaPermission(type)
  )
  ipcMain.handle(IpcChannels.permission.getLoginItem, () => getLoginItemEnabled())
  ipcMain.handle(IpcChannels.permission.setLoginItem, (_e, enable: boolean) =>
    setLoginItemEnabled(enable)
  )
}
