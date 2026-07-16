import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import {
  listModels,
  addModel,
  updateModel,
  removeModel,
  getModel,
  setActiveModel
} from '../models'
import type { ModelAddRequest, ModelUpdateRequest } from '../../shared/model-types'

/** 注册 models:* IPC handler */
export function registerModelIpcHandlers(): void {
  ipcMain.handle(IpcChannels.models.list, () => listModels())

  ipcMain.handle(IpcChannels.models.get, (_e, id: string) => getModel(id))

  ipcMain.handle(IpcChannels.models.add, (_e, request: ModelAddRequest) => addModel(request))

  ipcMain.handle(IpcChannels.models.update, (_e, request: ModelUpdateRequest) =>
    updateModel(request)
  )

  ipcMain.handle(IpcChannels.models.remove, (_e, id: string) => removeModel(id))

  ipcMain.handle(IpcChannels.models.setActive, (_e, id: string) => setActiveModel(id))
}
