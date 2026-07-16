import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import {
  createSession,
  listSessions,
  getSession,
  updateSession,
  deleteSession,
  searchSessions,
  exportSession,
  importSession
} from '../sessions'
import type {
  SessionSearchRequest,
  SessionUpdateRequest,
  SessionImportData
} from '../../shared/session-types'

/** 注册 sessions:* IPC handler */
export function registerSessionIpcHandlers(): void {
  ipcMain.handle(IpcChannels.sessions.create, (_e, request: { title: string; metadata?: Record<string, unknown> }) =>
    createSession(request)
  )

  ipcMain.handle(IpcChannels.sessions.list, () => listSessions())

  ipcMain.handle(IpcChannels.sessions.get, (_e, id: string) => getSession(id))

  ipcMain.handle(IpcChannels.sessions.update, (_e, request: SessionUpdateRequest) =>
    updateSession(request)
  )

  ipcMain.handle(IpcChannels.sessions.delete, (_e, id: string) => deleteSession(id))

  ipcMain.handle(IpcChannels.sessions.search, (_e, request: SessionSearchRequest) =>
    searchSessions(request)
  )

  ipcMain.handle(IpcChannels.sessions.export, (_e, id: string) => exportSession(id))

  ipcMain.handle(IpcChannels.sessions.import, (_e, data: SessionImportData) =>
    importSession(data)
  )
}
