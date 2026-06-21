import type { MediaPermissionType, PermissionStatus } from '@shared/types'

/**
 * 系统权限门面
 *
 * 用法:
 *   const status = await permission.check('microphone')
 *   if (status !== 'granted') await permission.request('microphone')
 *   await permission.setLaunchAtLogin(true)
 */
export const permission = {
  /** 查询媒体权限状态(microphone / camera / screen) */
  check(type: MediaPermissionType): Promise<PermissionStatus> {
    return window.api.permission.check(type)
  },

  /** 申请媒体权限(mac 弹系统授权框;win 由系统隐私设置控制) */
  request(type: MediaPermissionType): Promise<PermissionStatus> {
    return window.api.permission.request(type)
  },

  /** 查询是否开机自启 */
  getLaunchAtLogin(): Promise<boolean> {
    return window.api.permission.getLoginItem()
  },

  /** 设置开机自启 */
  setLaunchAtLogin(enable: boolean): Promise<void> {
    return window.api.permission.setLoginItem(enable)
  }
}
