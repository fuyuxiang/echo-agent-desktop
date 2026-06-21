/**
 * Shell 门面(系统级打开操作)
 *
 * 用法:
 *   await shellOpen.external('https://example.com')   // 系统浏览器打开
 *   await shellOpen.showInFolder('/path/to/file')      // 文件管理器中显示
 */
export const shellOpen = {
  /** 用系统默认浏览器打开链接(仅允许 http/https) */
  external(url: string): Promise<void> {
    return window.api.system.openExternal(url)
  },
  /** 在 Finder / 资源管理器中显示文件 */
  showInFolder(fullPath: string): Promise<void> {
    return window.api.system.showItemInFolder(fullPath)
  }
}
