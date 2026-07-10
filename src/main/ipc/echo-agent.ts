import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import {
  getEchoAgentStatus,
  getEchoAgentVersion,
  onEchoAgentStatus,
  updateEchoAgent,
  applyModelConfig
} from '../echo-agent'
import type { ModelConfigInput } from '../echo-agent/config-writer'

export function registerEchoAgentIpc(getWindow: () => Electron.BrowserWindow | null): void {
  ipcMain.handle(IpcChannels.echoAgent.getStatus, () => getEchoAgentStatus())
  ipcMain.handle(IpcChannels.echoAgent.getVersion, () => getEchoAgentVersion())
  ipcMain.handle(IpcChannels.echoAgent.update, () => updateEchoAgent())
  ipcMain.handle(IpcChannels.echoConfig.apply, (_e, cfg: ModelConfigInput) => applyModelConfig(cfg))

  onEchoAgentStatus((status) => {
    getWindow()?.webContents.send(IpcChannels.echoAgent.statusChanged, status)
  })
}
