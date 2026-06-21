import { BrowserWindow, ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'

/** 从 IPC 事件反查发起窗口(多窗口场景下也能正确响应) */
function senderWindow(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) {
  return BrowserWindow.fromWebContents(event.sender)
}

/** 注册窗口控制类 IPC(自定义标题栏按钮) */
export function registerWindowHandlers(): void {
  ipcMain.on(IpcChannels.window.minimize, (event) => {
    senderWindow(event)?.minimize()
  })

  ipcMain.on(IpcChannels.window.toggleMaximize, (event) => {
    const win = senderWindow(event)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })

  ipcMain.on(IpcChannels.window.close, (event) => {
    senderWindow(event)?.close()
  })

  ipcMain.handle(IpcChannels.window.isMaximized, (event) => {
    return senderWindow(event)?.isMaximized() ?? false
  })

  ipcMain.on(IpcChannels.window.setAlwaysOnTop, (event, flag: boolean) => {
    senderWindow(event)?.setAlwaysOnTop(flag)
  })
}
