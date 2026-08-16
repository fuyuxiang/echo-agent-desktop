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
export const UPDATE_ENABLED = false

/** 下载完成事件回调:把版本号透传给渲染层,渲染层负责弹提示并征求用户同意。 */
export type UpdateDownloadedListener = (info: { version: string }) => void

let downloadedListener: UpdateDownloadedListener | null = null

/**
 * 由 ipc/app.ts 注册:更新包下载完成后推送版本号给渲染层。
 * 渲染层提示用户,确认后调用 installUpdate() 才会真正退出安装。
 */
export function setUpdateDownloadedListener(fn: UpdateDownloadedListener | null): void {
  downloadedListener = fn
}

/** 初始化更新器(app ready 后调用) */
export function setupUpdater(): void {
  if (!UPDATE_ENABLED || !app.isPackaged) return

  autoUpdater.logger = log
  autoUpdater.autoDownload = true

  autoUpdater.on('update-downloaded', (info) => {
    log.info('[updater] 更新包已下载,版本:', info.version)
    // 仅推送事件,不擅自退出 —— 安装时机交由用户在 UI 上确认
    try {
      downloadedListener?.({ version: info.version })
    } catch (err) {
      log.error('[updater] 分发 update-downloaded 事件失败:', err)
    }
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

/**
 * 用户确认后立即退出并安装已下载的更新
 * @returns 是否真正触发安装(更新未启用或未打包时返回 false)
 */
export function installUpdate(): boolean {
  if (!UPDATE_ENABLED || !app.isPackaged) return false
  // isSilent=false: Windows 安装器保留提示;isForceRunAfter=true: 安装后自动重启新版本
  autoUpdater.quitAndInstall(false, true)
  return true
}
