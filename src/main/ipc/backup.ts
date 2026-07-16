import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import { listBackups, createBackup, restoreBackup, deleteBackup } from '../backup'
import type { BackupCreateRequest, BackupRestoreRequest } from '../../shared/settings-types'

/** 注册 backup:* IPC handler */
export function registerBackupIpcHandlers(): void {
  ipcMain.handle(IpcChannels.backup.list, () => listBackups())

  ipcMain.handle(IpcChannels.backup.create, (_e, request: BackupCreateRequest) =>
    createBackup(request)
  )

  ipcMain.handle(IpcChannels.backup.restore, (_e, request: BackupRestoreRequest) =>
    restoreBackup(request)
  )

  ipcMain.handle(IpcChannels.backup.delete, (_e, id: string) => deleteBackup(id))
}
