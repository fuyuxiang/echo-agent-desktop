/**
 * 应用级能力门面
 *
 * 用法:
 *   const version = await appControl.getVersion()
 *   appControl.relaunch()
 *   const off = appControl.onUpdateDownloaded((info) => { ... })
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
  },
  /** 监听更新下载完成事件,返回取消监听函数 */
  onUpdateDownloaded(callback: (info: { version: string }) => void): () => void {
    return window.api.app.onUpdateDownloaded(callback)
  },
  /** 立即退出并安装已下载的更新;未启用时返回 false */
  installUpdate(): Promise<boolean> {
    return window.api.app.installUpdate()
  },
  /** 监听 deep link 推送(主进程在协议唤起时调用),返回取消监听函数 */
  onDeepLink(callback: (payload: { path: string; query: Record<string, string> }) => void): () => void {
    return window.api.app.onDeepLink(callback)
  }
}
