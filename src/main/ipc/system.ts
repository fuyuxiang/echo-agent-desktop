import { clipboard, dialog, ipcMain, Notification, shell } from 'electron'
import type { NotifyOptions, OpenDialogOptions, SaveDialogOptions } from '@shared/types'
import { IpcChannels } from '@shared/ipc-channels'
import { log } from '../logger'
import { getMainWindow } from '../window'
import { parseDocReference } from '../protocol'

/** 从 echo://doc/<id>... URL 提取 docId;解析失败返回空串。 */
function extractDocId(url: string): string {
  return parseDocReference(url)?.docId ?? ''
}

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
    // echo://doc/<id>/page/<n> 引用跳转:把 ref 解析成 hash query 推到渲染层,
    // 由 /knowledge/doc 路由的 DocViewer 拉原文/PDF。
    if (url.startsWith('echo://')) {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        const ref = encodeURIComponent(url)
        // 触发渲染层 navigate;用广播 deep link 让前端用 react-router 跳转。
        win.webContents.send(IpcChannels.app.onDeepLink, {
          path: '/knowledge/doc',
          query: { id: extractDocId(url), ref }
        })
      }
      return
    }
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

  // 受限 Ollama 代理。禁止渲染层传任意 URL，避免页面注入后把主进程变成
  // 内网 SSRF/凭证转发器。
  ipcMain.handle(
    IpcChannels.system.ollamaRequest,
    async (
      _e,
      opts: {
        baseUrl: string
        path: '/api/version' | '/api/tags' | '/api/pull'
        method?: 'GET' | 'POST'
        body?: unknown
      }
    ) => {
      let parsed: URL
      try {
        parsed = new URL(opts.baseUrl)
      } catch {
        return { ok: false, status: 0, body: 'Ollama 地址无效' }
      }
      const allowedHost = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
      const allowedPath = ['/api/version', '/api/tags', '/api/pull'].includes(opts.path)
      if (!allowedHost || !allowedPath || parsed.username || parsed.password) {
        return { ok: false, status: 0, body: '仅允许访问本机 Ollama 固定接口' }
      }
      parsed.pathname = opts.path
      parsed.search = ''
      parsed.hash = ''
      const timeoutMs = opts.path === '/api/pull' ? 30 * 60_000 : 10_000
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const { net } = await import('electron')
        const resp = await net.fetch(parsed.toString(), {
          method: opts.method || 'GET',
          headers: opts.body === undefined ? undefined : { 'content-type': 'application/json' },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
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
