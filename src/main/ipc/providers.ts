import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import {
  listProviders,
  addProvider,
  updateProvider,
  removeProvider,
  getProvider,
  testProvider
} from '../providers'
import type { ProviderAddRequest, ProviderUpdateRequest, ProviderTestRequest } from '../../shared/provider-types'

/** 注册 providers:* IPC handler */
export function registerProviderIpcHandlers(): void {
  ipcMain.handle(IpcChannels.providers.list, () => listProviders())

  ipcMain.handle(IpcChannels.providers.get, (_e, id: string) => getProvider(id))

  ipcMain.handle(IpcChannels.providers.add, (_e, request: ProviderAddRequest) => addProvider(request))

  ipcMain.handle(IpcChannels.providers.update, (_e, request: ProviderUpdateRequest) =>
    updateProvider(request)
  )

  ipcMain.handle(IpcChannels.providers.remove, (_e, id: string) => removeProvider(id))

  ipcMain.handle(IpcChannels.providers.test, (_e, request: ProviderTestRequest) => testProvider(request))
}
