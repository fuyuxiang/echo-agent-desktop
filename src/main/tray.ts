import { join } from 'node:path'
import { app, Menu, nativeImage, Tray } from 'electron'
import { log } from './logger'
import { showMainWindow } from './window'

/** 托盘实例(必须持有引用,否则被 GC 后托盘消失) */
let tray: Tray | null = null

/**
 * 创建系统托盘
 *
 * - mac: 菜单栏图标(Template 图,自动适配深浅色)
 * - win: 任务栏托盘图标,双击显示主窗口
 * - 图标文件: resources/trayTemplate.png(占位图,正式图标待设计提供)
 */
export function setupTray(): void {
  const iconPath = join(app.isPackaged ? process.resourcesPath : 'resources', 'trayTemplate.png')
  let icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) {
    log.warn('[tray] 托盘图标缺失,使用空图标占位:', iconPath)
    icon = nativeImage.createEmpty()
  } else {
    icon = icon.resize({ width: 16, height: 16 })
    // mac Template 图:系统自动适配深浅色菜单栏
    icon.setTemplateImage(true)
  }

  tray = new Tray(icon)
  tray.setToolTip('Echo Agent')

  const contextMenu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showMainWindow() },
    { type: 'separator' },
    { label: '退出 Echo Agent', click: () => app.quit() }
  ])
  tray.setContextMenu(contextMenu)

  // win 习惯:双击托盘显示主窗口(mac 无双击事件,点击弹菜单)
  tray.on('double-click', () => showMainWindow())
}

/** 销毁托盘(应用退出时调用) */
export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
