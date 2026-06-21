/**
 * 基础能力统一出口
 *
 * 页面开发常用:
 *   import { storage, db, logger, notify, clipboard, appWindow } from '@/utils'
 */
export { storage } from './storage'
export { db } from './db'
export { permission } from './permission'
export { logger, setupGlobalErrorCapture } from './logger'
export { notify } from './notification'
export { clipboard } from './clipboard'
export { shellOpen } from './shell'
export { fileDialog } from './dialog'
export { appWindow } from './window'
export { isMac, isWin, platform } from './platform'
export { appControl } from './app'
export { eventBus } from './event-bus'
export { formatTime, formatSmartTime, formatFileSize, formatNumber } from './format'
export { isObject, isFunction, isString, isNumber, isEmpty, isHttpUrl } from './is'
export { agentHttp } from './agent'
