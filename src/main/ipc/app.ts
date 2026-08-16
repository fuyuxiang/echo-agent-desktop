import { app, ipcMain, type BrowserWindow } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import { checkForUpdates, installUpdate, setUpdateDownloadedListener } from '../updater'

/**
 * 注册应用级 IPC(版本/重启/退出/检查更新/更新下载完成推送)
 *
 * getWindow 在注册中心传入,用于把更新下载完成事件推给渲染层;
 * 缺省时只注册请求-响应类 IPC,推送能力降级。
 */
export function registerAppHandlers(
  getWindow?: () => BrowserWindow | null
): void {
  ipcMain.handle(IpcChannels.app.getVersion, () => app.getVersion())

  ipcMain.on(IpcChannels.app.relaunch, () => {
    app.relaunch()
    app.exit(0)
  })

  ipcMain.on(IpcChannels.app.quit, () => {
    app.quit()
  })

  ipcMain.handle(IpcChannels.app.checkForUpdates, () => checkForUpdates())
  ipcMain.handle(IpcChannels.app.installUpdate, () => installUpdate())

  // 更新包下载完成后,把版本号推给渲染层;窗口未就绪或已销毁则跳过。
  setUpdateDownloadedListener((info) => {
    const win = getWindow?.()
    if (!win || win.isDestroyed()) return
    win.webContents.send(IpcChannels.app.onUpdateDownloaded, info)
  })
}
