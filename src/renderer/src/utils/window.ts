/**
 * 窗口控制门面(自定义标题栏按钮使用)
 *
 * 用法:
 *   appWindow.minimize()
 *   appWindow.toggleMaximize()
 *   const off = appWindow.onMaximizeChanged((max) => setMaximized(max))
 */
export const appWindow = {
  /** 最小化 */
  minimize(): void {
    window.api.window.minimize()
  },
  /** 最大化/还原切换 */
  toggleMaximize(): void {
    window.api.window.toggleMaximize()
  },
  /** 关闭窗口 */
  close(): void {
    window.api.window.close()
  },
  /** 查询是否最大化 */
  isMaximized(): Promise<boolean> {
    return window.api.window.isMaximized()
  },
  /** 设置窗口置顶 */
  setAlwaysOnTop(flag: boolean): void {
    window.api.window.setAlwaysOnTop(flag)
  },
  /** 监听最大化状态变化,返回取消监听函数 */
  onMaximizeChanged(callback: (maximized: boolean) => void): () => void {
    return window.api.window.onMaximizeChanged(callback)
  }
}
