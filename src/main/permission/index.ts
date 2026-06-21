import { app, systemPreferences } from 'electron'
import type { MediaPermissionType, PermissionStatus } from '@shared/types'
import { log } from '../logger'

/**
 * 系统权限管理
 *
 * - 媒体权限(麦克风/摄像头/屏幕录制): mac 走系统授权框,win 由系统隐私设置控制
 * - 开机自启: mac/win 双端支持(app.setLoginItemSettings)
 */

/** 查询媒体权限状态 */
export function checkMediaPermission(type: MediaPermissionType): PermissionStatus {
  // getMediaAccessStatus 支持 mac 与 win10+;其他平台默认视为已授权
  if (process.platform !== 'darwin' && process.platform !== 'win32') return 'granted'
  try {
    return systemPreferences.getMediaAccessStatus(type) as PermissionStatus
  } catch (err) {
    log.warn('[permission] 查询权限状态失败:', type, err)
    return 'unknown'
  }
}

/**
 * 申请媒体权限
 * - mac: 麦克风/摄像头弹系统授权框;屏幕录制需用户到系统设置手动开启
 * - win: 无应用级授权框,直接返回当前状态(由系统隐私设置控制)
 */
export async function requestMediaPermission(type: MediaPermissionType): Promise<PermissionStatus> {
  if (process.platform === 'darwin' && (type === 'microphone' || type === 'camera')) {
    const granted = await systemPreferences.askForMediaAccess(type)
    return granted ? 'granted' : 'denied'
  }
  return checkMediaPermission(type)
}

/** 查询是否开机自启 */
export function getLoginItemEnabled(): boolean {
  return app.getLoginItemSettings().openAtLogin
}

/** 设置开机自启 */
export function setLoginItemEnabled(enable: boolean): void {
  app.setLoginItemSettings({ openAtLogin: enable })
  log.info('[permission] 开机自启已设置为:', enable)
}
