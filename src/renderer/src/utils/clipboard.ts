/**
 * 剪贴板门面
 *
 * 用法:
 *   await clipboard.writeText('复制内容')
 *   const text = await clipboard.readText()
 */
export const clipboard = {
  /** 读取剪贴板文本 */
  readText(): Promise<string> {
    return window.api.system.clipboardReadText()
  },
  /** 写入文本到剪贴板 */
  writeText(text: string): Promise<void> {
    return window.api.system.clipboardWriteText(text)
  }
}
