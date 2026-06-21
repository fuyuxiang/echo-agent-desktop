import { app, ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import { checkForUpdates } from '../updater'

/** 注册应用级 IPC(版本/重启/退出/检查更新) */
export function registerAppHandlers(): void {
  ipcMain.handle(IpcChannels.app.getVersion, () => app.getVersion())

  ipcMain.on(IpcChannels.app.relaunch, () => {
    app.relaunch()
    app.exit(0)
  })

  ipcMain.on(IpcChannels.app.quit, () => {
    app.quit()
  })

  ipcMain.handle(IpcChannels.app.checkForUpdates, () => checkForUpdates())
}
