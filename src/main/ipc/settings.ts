import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import { storeGet, storeSet } from '../store'
import type { SettingsConfig, SettingsUpdateRequest } from '../../shared/settings-types'
import { randomUUID } from 'crypto'

const SETTINGS_KEY = 'settings.config'

function getOrCreateSettings(): SettingsConfig {
  let settings = storeGet<SettingsConfig>(SETTINGS_KEY)
  if (!settings) {
    settings = {
      id: randomUUID(),
      theme: 'system',
      language: 'zh-CN',
      network: {
        timeout: 30000
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    storeSet(SETTINGS_KEY, settings)
  }
  return settings
}

export async function getSettings(): Promise<SettingsConfig> {
  return getOrCreateSettings()
}

export async function updateSettings(request: SettingsUpdateRequest): Promise<SettingsConfig> {
  const settings = getOrCreateSettings()
  const updated: SettingsConfig = {
    ...settings,
    ...(request.theme !== undefined && { theme: request.theme }),
    ...(request.language !== undefined && { language: request.language }),
    ...(request.network !== undefined && { network: request.network }),
    ...(request.metadata !== undefined && { metadata: request.metadata }),
    updatedAt: new Date().toISOString()
  }
  storeSet(SETTINGS_KEY, updated)
  return updated
}

/** 注册 settings:* IPC handler */
export function registerSettingsIpcHandlers(): void {
  ipcMain.handle(IpcChannels.settings.get, () => getSettings())

  ipcMain.handle(IpcChannels.settings.update, (_e, request: SettingsUpdateRequest) =>
    updateSettings(request)
  )
}
