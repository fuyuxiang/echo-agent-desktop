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

  // 通用 HTTP 代理(P6 从 agent 段迁出): 渲染层经主进程发起请求, 绕过 CORS
  // 安全防护: 仅 http/https; 拒绝嵌入凭据; 支持超时中断(默认 30s)
  ipcMain.handle(
    IpcChannels.system.httpProxy,
    async (
      _e,
      opts: {
        url: string
        method?: string
        headers?: Record<string, string>
        body?: string
        timeoutMs?: number
      }
    ) => {
      let parsed: URL
      try {
        parsed = new URL(opts.url)
      } catch {
        return { ok: false, status: 0, body: `非法 URL: ${opts.url}` }
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, status: 0, body: `不支持的协议: ${parsed.protocol}` }
      }
      if (parsed.username || parsed.password) {
        return { ok: false, status: 0, body: 'URL 不允许包含嵌入凭据' }
      }
      const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 30_000
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const { net } = await import('electron')
        const resp = await net.fetch(parsed.toString(), {
          method: opts.method || 'GET',
          headers: opts.headers,
          body: opts.body,
          signal: controller.signal
        })
        const text = await resp.text()
        return { ok: resp.ok, status: resp.status, body: text }
      } catch (e) {
        const aborted = controller.signal.aborted
        return {
          ok: false,
          status: 0,
          body: aborted ? `请求超时(${timeoutMs}ms)` : (e as Error).message
        }
      } finally {
        clearTimeout(timer)
      }
    }
  )
}
