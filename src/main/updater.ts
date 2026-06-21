import { app } from 'electron'
import electronUpdater from 'electron-updater'
import { log } from './logger'

const { autoUpdater } = electronUpdater

/**
 * 自动更新(electron-updater)— 预留实现
 *
 * 当前状态: 更新服务器未就绪,仅在打包环境下尝试检查,失败静默
 * 启用步骤:
 * 1. 在 electron-builder.yml 配置 publish(generic/github 等更新源)
 * 2. 将 UPDATE_ENABLED 改为 true
 * 3. 按需接入下载进度/重启安装的 IPC 推送
 */
const UPDATE_ENABLED = false

/** 初始化更新器(app ready 后调用) */
export function setupUpdater(): void {
  if (!UPDATE_ENABLED || !app.isPackaged) return

  autoUpdater.logger = log
  autoUpdater.autoDownload = true

  autoUpdater.on('update-downloaded', (info) => {
    log.info('[updater] 更新包已下载,版本:', info.version)
    // TODO: 通知渲染层提示用户重启安装(autoUpdater.quitAndInstall())
  })

  autoUpdater.checkForUpdates().catch((err) => {
    log.warn('[updater] 检查更新失败:', err?.message)
  })
}

/**
 * 手动检查更新(渲染层"检查更新"按钮调用)
 * @returns 有新版本返回版本号,无更新或未启用返回 null
 */
export async function checkForUpdates(): Promise<string | null> {
  if (!UPDATE_ENABLED || !app.isPackaged) return null
  try {
    const result = await autoUpdater.checkForUpdates()
    return result?.updateInfo?.version ?? null
  } catch (err) {
    log.warn('[updater] 手动检查更新失败:', err)
    return null
  }
}
