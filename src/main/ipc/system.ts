import { clipboard, dialog, ipcMain, Notification, shell } from 'electron'
import type { NotifyOptions, OpenDialogOptions, SaveDialogOptions } from '@shared/types'
import { IpcChannels } from '@shared/ipc-channels'
import { log } from '../logger'
import { getMainWindow } from '../window'

/** 注册系统能力类 IPC(通知/剪贴板/shell/对话框) */
export function registerSystemHandlers(): void {
  ipcMain.handle(IpcChannels.system.notify, (_e, options: NotifyOptions) => {
    if (!Notification.isSupported()) {
      log.warn('[system] 当前系统不支持通知')
      return
    }
    new Notification({
      title: options.title,
      body: options.body,
      silent: options.silent
    }).show()
  })

  ipcMain.handle(IpcChannels.system.clipboardReadText, () => clipboard.readText())
  ipcMain.handle(IpcChannels.system.clipboardWriteText, (_e, text: string) =>
    clipboard.writeText(text)
  )

  ipcMain.handle(IpcChannels.system.openExternal, (_e, url: string) => {
    // 仅允许 http/https,防止任意协议注入
    if (!/^https?:\/\//.test(url)) {
      log.warn('[system] 拦截非法外链:', url)
      return
    }
    return shell.openExternal(url)
  })

  ipcMain.handle(IpcChannels.system.showItemInFolder, (_e, fullPath: string) =>
    shell.showItemInFolder(fullPath)
  )

  ipcMain.handle(IpcChannels.system.showOpenDialog, async (_e, options: OpenDialogOptions) => {
    const win = getMainWindow()
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle(IpcChannels.system.showSaveDialog, async (_e, options: SaveDialogOptions) => {
    const win = getMainWindow()
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
    return result.canceled ? null : (result.filePath ?? null)
  })
}
