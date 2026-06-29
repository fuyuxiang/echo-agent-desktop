import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import { getEchoAgentStatus, onEchoAgentStatus, updateEchoAgent } from '../echo-agent'

export function registerEchoAgentIpc(getWindow: () => Electron.BrowserWindow | null): void {
  ipcMain.handle(IpcChannels.echoAgent.getStatus, () => getEchoAgentStatus())
  ipcMain.handle(IpcChannels.echoAgent.update, () => updateEchoAgent())

  onEchoAgentStatus((status) => {
    getWindow()?.webContents.send(IpcChannels.echoAgent.statusChanged, status)
  })
}
