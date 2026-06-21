import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { setupLogger, log } from './logger'
import { createMainWindow, showMainWindow } from './window'
import { setupTray, destroyTray } from './tray'
import { setupShortcuts } from './shortcut'
import { setupUpdater } from './updater'
import { setupProtocol, extractDeepLinkFromArgv, handleDeepLink } from './protocol'
import { setupDatabase, closeDatabase } from './db'
import { registerAllIpcHandlers } from './ipc'
import { initASR } from './asr'
import { startAgent, stopAgent } from './agent-process/manager'
import { getEnvInfo } from './agent-process/python-env'
import { hasAgentConfig } from './agent-process/config-gen'
import { secureGet } from './store'

/**
 * 主进程入口
 *
 * 启动顺序: 单实例锁 -> 日志 -> ready -> 数据库/IPC/窗口/托盘/快捷键/更新/协议
 */

// ===== 单实例锁:重复启动时聚焦已有窗口 =====
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  setupLogger()

  app.on('second-instance', (_event, argv) => {
    // Windows 下 deep link 通过第二实例的 argv 传入
    const deepLink = extractDeepLinkFromArgv(argv)
    if (deepLink) handleDeepLink(deepLink)
    else showMainWindow()
  })

  app.whenReady().then(() => {
    // win 通知/任务栏分组需要 AppUserModelId
    electronApp.setAppUserModelId('com.echo.agent-desktop')

    // 开发期 F12 开关 DevTools,生产屏蔽刷新快捷键
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    setupDatabase()
    registerAllIpcHandlers()
    initASR()
    createMainWindow()
    setupTray()
    setupShortcuts()
    setupUpdater()
    setupProtocol()

    // 尝试自动启动 Agent（环境就绪且有配置时）
    getEnvInfo()
      .then(async (info) => {
        if (info.status === 'ready' && hasAgentConfig()) {
          log.info('[main] 环境就绪，自动启动 Agent')
          const keys = getAutoStartApiKeys()
          const result = await startAgent(keys)
          if (!result.success) {
            log.warn('[main] Agent 自动启动失败:', result.error)
          }
        } else {
          log.info('[main] 环境未就绪或无配置，等待用户初始化')
        }
      })
      .catch((e) => {
        log.error('[main] Agent 启动检查失败:', e)
      })

    // mac: 点击 Dock 图标且无窗口时重建窗口
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
      else showMainWindow()
    })
  })

  // ===== 安全基线:统一管控所有 webContents =====
  app.on('web-contents-created', (_event, contents) => {
    // 禁止页面内导航到外部站点(防钓鱼/注入)
    contents.on('will-navigate', (event, url) => {
      const isDevServer =
        !app.isPackaged &&
        process.env['ELECTRON_RENDERER_URL'] &&
        url.startsWith(process.env['ELECTRON_RENDERER_URL'])
      if (!isDevServer && !url.startsWith('file://')) {
        log.warn('[security] 拦截页面导航:', url)
        event.preventDefault()
      }
    })
  })

  // 关闭所有窗口时退出(mac 习惯是常驻 Dock,但本应用有托盘,保持双端一致退出逻辑可后续再调)
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  // 退出前优雅停止 Agent 子进程: 必须等待 stopAgent 完成再真正退出,
  // 否则子进程(detached:false)在 POSIX 上不随主进程退出, 会残留孤儿 python 进程并占用端口。
  let cleanupDone = false
  app.on('before-quit', (event) => {
    if (cleanupDone) return
    event.preventDefault()
    destroyTray()
    Promise.resolve()
      .then(() => stopAgent())
      .catch((e) => log.error('[main] Agent 停止失败:', e))
      .finally(() => {
        closeDatabase()
        cleanupDone = true
        log.info('[main] 应用退出')
        app.quit()
      })
  })
}

function getAutoStartApiKeys(): Record<string, string> {
  const keys: Record<string, string> = {}
  const openaiKey = secureGet('openai-api-key')
  const anthropicKey = secureGet('anthropic-api-key')
  const geminiKey = secureGet('gemini-api-key')
  const openrouterKey = secureGet('openrouter-api-key')

  if (openaiKey) keys.OPENAI_API_KEY = openaiKey
  if (anthropicKey) keys.ANTHROPIC_API_KEY = anthropicKey
  if (geminiKey) keys.GOOGLE_API_KEY = geminiKey
  if (openrouterKey) keys.OPENROUTER_API_KEY = openrouterKey

  return keys
}
