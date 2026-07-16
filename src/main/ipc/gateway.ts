import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import {
  listPlatforms,
  listConfigs,
  addConfig,
  updateConfig,
  removeConfig,
  getStatus,
  testConnection,
  sendMessage,
  listMessages
} from '../gateway'
import type {
  GatewayConfigAddRequest,
  GatewayConfigUpdateRequest,
  GatewayTestRequest
} from '../../shared/gateway-types'

/** 注册 gateway:* IPC handler */
export function registerGatewayIpcHandlers(): void {
  ipcMain.handle(IpcChannels.gateway.listPlatforms, () => listPlatforms())

  ipcMain.handle(IpcChannels.gateway.listConfigs, () => listConfigs())

  ipcMain.handle(IpcChannels.gateway.addConfig, (_e, request: GatewayConfigAddRequest) =>
    addConfig(request)
  )

  ipcMain.handle(IpcChannels.gateway.updateConfig, (_e, request: GatewayConfigUpdateRequest) =>
    updateConfig(request)
  )

  ipcMain.handle(IpcChannels.gateway.removeConfig, (_e, id: string) => removeConfig(id))

  ipcMain.handle(IpcChannels.gateway.getStatus, (_e, platformId: string) => getStatus(platformId))

  ipcMain.handle(IpcChannels.gateway.testConnection, (_e, request: GatewayTestRequest) =>
    testConnection(request)
  )

  ipcMain.handle(IpcChannels.gateway.sendMessage, (_e, request: { platformId: string; content: string; metadata?: Record<string, unknown> }) =>
    sendMessage(request)
  )

  ipcMain.handle(IpcChannels.gateway.listMessages, (_e, platformId?: string) => listMessages(platformId))
}
