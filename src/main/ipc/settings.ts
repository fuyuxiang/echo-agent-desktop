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
      // 默认唯一支持的运行时:Python echo-agent。第二期会删除 legacy-ts。
      agentRuntime: 'python',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    storeSet(SETTINGS_KEY, settings)
  }
  // 兼容旧 settings:补一个默认 runtime,不让旧存储里缺字段。
  if (!settings.agentRuntime) {
    settings.agentRuntime = 'python'
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
    ...(request.agentRuntime !== undefined && { agentRuntime: request.agentRuntime }),
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
