import { app, ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import { listBackups, createBackup, restoreBackup, deleteBackup } from '../backup'
import type { BackupCreateRequest, BackupRestoreRequest } from '../../shared/settings-types'
import { closeDatabase, setupDatabase } from '../db'
import { getEchoAgentStatus, startEchoAgent, stopEchoAgent } from '../echo-agent'

/** 注册 backup:* IPC handler */
export function registerBackupIpcHandlers(): void {
  ipcMain.handle(IpcChannels.backup.list, () => listBackups())

  ipcMain.handle(IpcChannels.backup.create, async (_e, request: BackupCreateRequest) => {
    const restartAgent = getEchoAgentStatus().phase === 'ready'
    if (restartAgent) await stopEchoAgent()
    try {
      return await createBackup(request)
    } finally {
      if (restartAgent) await startEchoAgent()
    }
  })

  ipcMain.handle(IpcChannels.backup.restore, async (_e, request: BackupRestoreRequest) => {
    await stopEchoAgent()
    closeDatabase()
    try {
      await restoreBackup(request)
    } catch (e) {
      // 恢复失败时把当前数据库重新打开，应用仍可继续使用。
      setupDatabase()
      throw e
    }
    // electron-store 已缓存旧配置，原地继续运行会形成半恢复状态；重启是
    // 恢复事务的一部分，让 DB、配置和 Agent 工作区在同一冷启动加载。
    app.relaunch()
    app.quit()
  })

  ipcMain.handle(IpcChannels.backup.delete, (_e, id: string) => deleteBackup(id))
}
