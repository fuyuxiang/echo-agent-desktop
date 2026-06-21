import dayjs from 'dayjs'

/**
 * 格式化工具集
 */

/**
 * 格式化时间戳
 * @param timestamp 毫秒时间戳
 * @param template 格式模板,默认 YYYY-MM-DD HH:mm:ss
 * @example formatTime(1700000000000) // '2023-11-15 06:13:20'
 */
export function formatTime(timestamp: number, template = 'YYYY-MM-DD HH:mm:ss'): string {
  return dayjs(timestamp).format(template)
}

/**
 * 智能相对时间(聊天列表常用): 今天显示时分,今年显示月日,跨年显示完整日期
 */
export function formatSmartTime(timestamp: number): string {
  const target = dayjs(timestamp)
  const now = dayjs()
  if (target.isSame(now, 'day')) return target.format('HH:mm')
  if (target.isSame(now, 'year')) return target.format('MM-DD HH:mm')
  return target.format('YYYY-MM-DD')
}

/**
 * 格式化文件大小
 * @example formatFileSize(1536) // '1.5 KB'
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = -1
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`
}

/**
 * 千分位数字
 * @example formatNumber(1234567) // '1,234,567'
 */
export function formatNumber(num: number): string {
  return num.toLocaleString('en-US')
}
