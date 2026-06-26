import { join } from 'node:path'
import { BrowserWindow, shell } from 'electron'
import windowStateKeeper from 'electron-window-state'
import { is } from '@electron-toolkit/utils'
import { IpcChannels } from '@shared/ipc-channels'

/** 主窗口实例(单窗口应用;多窗口需求出现时再扩展为 Map 管理) */
let mainWindow: BrowserWindow | null = null

/**
 * 创建主窗口
 *
 * - 无边框 + 自定义标题栏: mac 用 hiddenInset 保留红绿灯,win 完全自绘三键
 * - electron-window-state 记忆窗口大小/位置
 * - 安全基线: 禁用 nodeIntegration,启用 contextIsolation
 */
export function createMainWindow(): BrowserWindow {
  // 记忆上次窗口大小与位置
  const windowState = windowStateKeeper({
    defaultWidth: 1200,
    defaultHeight: 800
  })

  const isMac = process.platform === 'darwin'

  mainWindow = new BrowserWindow({
    x: windowState.x,
    y: windowState.y,
    width: windowState.width,
    height: windowState.height,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    // mac: 隐藏标题栏但保留红绿灯;win: 完全无边框,标题栏自绘
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const } : { frame: false }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      nodeIntegration: false,
      contextIsolation: true,
      // preload 仅用 contextBridge/ipcRenderer,不依赖 Node 模块,可开启沙箱收敛提权面
      sandbox: true
    }
  })

  windowState.manage(mainWindow)

  // 准备好再显示,避免白屏闪烁
  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // 最大化状态变化推送给渲染层(标题栏按钮图标切换用)
  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send(IpcChannels.window.onMaximizeChanged, true)
  })
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send(IpcChannels.window.onMaximizeChanged, false)
  })

  // 渲染层内的链接一律交给系统浏览器,禁止应用内开新窗口;仅放行 http/https,
  // 防止 file:/自定义协议被唤起触发本地程序执行
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 开发环境加载 dev server,生产加载本地文件
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

/** 获取主窗口实例(可能为 null) */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/** 显示并聚焦主窗口(不存在则创建) */
export function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** 切换主窗口显示/隐藏(全局快捷键用) */
export function toggleMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow()
    return
  }
  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide()
  } else {
    showMainWindow()
  }
}
