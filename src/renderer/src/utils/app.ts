/**
 * 应用级能力门面
 *
 * 用法:
 *   const version = await appControl.getVersion()
 *   appControl.relaunch()
 */
export const appControl = {
  /** 获取应用版本号 */
  getVersion(): Promise<string> {
    return window.api.app.getVersion()
  },
  /** 重启应用 */
  relaunch(): void {
    window.api.app.relaunch()
  },
  /** 退出应用 */
  quit(): void {
    window.api.app.quit()
  },
  /** 检查更新:有新版本返回版本号,无更新或未启用返回 null */
  checkForUpdates(): Promise<string | null> {
    return window.api.app.checkForUpdates()
  }
}
