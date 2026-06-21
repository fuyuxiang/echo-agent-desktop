import type { NotifyOptions } from '@shared/types'

/**
 * 系统通知门面
 *
 * 用法:
 *   await notify({ title: '下载完成', body: '文件已保存到桌面' })
 */
export function notify(options: NotifyOptions): Promise<void> {
  return window.api.system.notify(options)
}
