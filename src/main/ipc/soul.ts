import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import {
  listSouls,
  getSoul,
  addSoul,
  updateSoul,
  deleteSoul,
  setActiveSoul,
  addTemplate,
  updateTemplate,
  deleteTemplate
} from '../soul'
import type {
  SoulAddRequest,
  SoulUpdateRequest
} from '../../shared/soul-types'

/** 注册 soul:* IPC handler */
export function registerSoulIpcHandlers(): void {
  ipcMain.handle(IpcChannels.soul.list, () => listSouls())

  ipcMain.handle(IpcChannels.soul.get, (_e, id: string) => getSoul(id))

  ipcMain.handle(IpcChannels.soul.add, (_e, request: SoulAddRequest) => addSoul(request))

  ipcMain.handle(IpcChannels.soul.update, (_e, request: SoulUpdateRequest) =>
    updateSoul(request)
  )

  ipcMain.handle(IpcChannels.soul.delete, (_e, id: string) => deleteSoul(id))

  ipcMain.handle(IpcChannels.soul.setActive, (_e, id: string) => setActiveSoul(id))

  ipcMain.handle(IpcChannels.soul.addTemplate, (_e, request: { name: string; content: string; category: string; description?: string }) =>
    addTemplate(request)
  )

  ipcMain.handle(IpcChannels.soul.updateTemplate, (_e, request: { id: string; name?: string; content?: string; category?: string; description?: string }) =>
    updateTemplate(request)
  )

  ipcMain.handle(IpcChannels.soul.deleteTemplate, (_e, id: string) => deleteTemplate(id))
}
