import { app, BrowserWindow, session, desktopCapturer } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { setupLogger, log } from './logger'
import { createMainWindow, showMainWindow } from './window'
import { setupTray, destroyTray } from './tray'
import { setupShortcuts } from './shortcut'
import { setupUpdater } from './updater'
import { setupProtocol, extractDeepLinkFromArgv, handleDeepLink } from './protocol'
import { setupDatabase, closeDatabase } from './db'
import { findRecordingMeetings, updateMeetingStatus } from './db/dao/meeting'
import { reapOrphans } from './meeting/orphan'
import { registerAllIpcHandlers } from './ipc'
import { initASR } from './asr'
// P5: Python agent 不再主进程拉起,改由渲染层 initAgentRuntime;以下导入保留到 P6 物理删除
// import { startAgent, stopAgent } from './agent-process/manager'
// import { getEnvInfo } from './agent-process/python-env'
// import { hasAgentConfig } from './agent-process/config-gen'
// import { secureGet } from './store'

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
    // 崩溃恢复:上次未正常结束(仍处 recording)的会议标记为 failed,
    // 已转写分段与录音文件保留,仅记录其未正常结束。
    for (const id of reapOrphans(findRecordingMeetings())) {
      updateMeetingStatus(id, 'failed')
    }
    registerAllIpcHandlers()
    initASR()
    createMainWindow()

    // 系统音频 loopback handler:渲染端 getDisplayMedia({audio:true}) 时,
    // 回调系统音频轨(macOS 经 ScreenCaptureKit)。拿不到时渲染端自动降级仅麦克风。
    session.defaultSession.setDisplayMediaRequestHandler(
      (_request, callback) => {
        desktopCapturer
          .getSources({ types: ['screen'] })
          .then((sources) => {
            callback({ video: sources[0], audio: 'loopback' })
          })
          .catch((err) => {
            log.warn('[main] desktopCapturer 获取屏幕源失败:', err)
            callback({})
          })
      },
      { useSystemPicker: false }
    )

    setupTray()
    setupShortcuts()
    setupUpdater()
    setupProtocol()

    // P5: 不再自动拉起 Python Agent,运行时由渲染层配置就绪后经 agent:chat:init 装配
    // (startAgent/stopAgent/getEnvInfo/hasAgentConfig 物理删除归 P6)
    log.info('[main] 跳过 Python Agent 自动启动,等待渲染层 initAgentRuntime')

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
    // P5: 不再调 stopAgent,Python agent 进程已无启动接线
    Promise.resolve()
      .then(() => {
        // 预留: 后续如果有原生 runtime 资源释放,放这里
      })
      .catch((e) => log.error('[main] 退出清理失败:', e))
      .finally(() => {
        closeDatabase()
        cleanupDone = true
        log.info('[main] 应用退出')
        app.quit()
      })
  })
}

// P5: getAutoStartApiKeys 不再使用,渲染层 initAgentRuntime 时单 key 取
// function getAutoStartApiKeys(): Record<string, string> {
//   const keys: Record<string, string> = {}
//   const openaiKey = secureGet('openai-api-key')
//   const anthropicKey = secureGet('anthropic-api-key')
//   const geminiKey = secureGet('gemini-api-key')
//   const openrouterKey = secureGet('openrouter-api-key')
//   if (openaiKey) keys.OPENAI_API_KEY = openaiKey
//   if (anthropicKey) keys.ANTHROPIC_API_KEY = anthropicKey
//   if (geminiKey) keys.GOOGLE_API_KEY = geminiKey
//   if (openrouterKey) keys.OPENROUTER_API_KEY = openrouterKey
//   return keys
// }
