/**
 * 类型判断工具集
 */

/** 是否为非 null 对象 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 是否为函数 */
export function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function'
}

/** 是否为字符串 */
export function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/** 是否为有效数字(排除 NaN) */
export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && !Number.isNaN(value)
}

/** 是否为空值(null / undefined / 空字符串 / 空数组 / 空对象) */
export function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (isString(value)) return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  if (isObject(value)) return Object.keys(value).length === 0
  return false
}

/** 是否为合法 http/https 链接 */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\/.+/.test(value)
}
