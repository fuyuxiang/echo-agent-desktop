import { ipcMain } from 'electron'
import { listLogs, addLog, clearLogs, getLogById, deleteLog, getLogStats } from '../logs'
import { IpcChannels } from '../../shared/ipc-channels'
import type { LogQueryRequest, LogLevel } from '../../shared/settings-types'

export function registerLogsIpcHandlers(): void {
  ipcMain.handle(IpcChannels.logs.list, async (_event, request?: LogQueryRequest) => {
    return await listLogs(request)
  })

  ipcMain.handle(
    IpcChannels.logs.add,
    async (_event, level: LogLevel, message: string, metadata?: Record<string, unknown>) => {
      return await addLog(level, message, metadata)
    }
  )

  ipcMain.handle(IpcChannels.logs.clear, async () => {
    return await clearLogs()
  })

  ipcMain.handle(IpcChannels.logs.getById, async (_event, id: string) => {
    return await getLogById(id)
  })

  ipcMain.handle(IpcChannels.logs.delete, async (_event, id: string) => {
    return await deleteLog(id)
  })

  ipcMain.handle(IpcChannels.logs.stats, async () => {
    return await getLogStats()
  })
}
