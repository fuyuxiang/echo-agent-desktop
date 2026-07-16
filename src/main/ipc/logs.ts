import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import { storeGet } from '../store'
import type { LogEntry, LogListResponse, LogQueryRequest } from '../../shared/settings-types'

const LOGS_KEY = 'logs.entries'

function getAllLogs(): LogEntry[] {
  return storeGet<LogEntry[]>(LOGS_KEY) ?? []
}

export async function listLogs(request?: LogQueryRequest): Promise<LogListResponse> {
  let logs = getAllLogs()

  if (request?.level) {
    logs = logs.filter(log => log.level === request.level)
  }

  if (request?.startTime) {
    logs = logs.filter(log => log.timestamp >= request.startTime!)
  }

  if (request?.endTime) {
    logs = logs.filter(log => log.timestamp <= request.endTime!)
  }

  logs.sort((a, b) => b.timestamp.localeCompare(a.timestamp))

  const total = logs.length
  const offset = request?.offset ?? 0
  const limit = request?.limit ?? 50
  const paginated = logs.slice(offset, offset + limit)

  return {
    logs: paginated,
    total
  }
}

/** 注册 logs:* IPC handler */
export function registerLogsIpcHandlers(): void {
  ipcMain.handle(IpcChannels.logs.list, (_e, request?: LogQueryRequest) => listLogs(request))
}
