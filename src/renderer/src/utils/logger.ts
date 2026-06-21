/**
 * 日志门面(渲染层日志自动汇入主进程日志文件 userData/logs/main.log)
 *
 * 用法:
 *   logger.info('页面加载完成', { page: 'chat' })
 *   logger.error('请求失败', err)
 */

function serialize(args: unknown[]): string {
  return args
    .map((arg) => {
      if (arg instanceof Error) return `${arg.message}\n${arg.stack}`
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg)
        } catch {
          return String(arg)
        }
      }
      return String(arg)
    })
    .join(' ')
}

export const logger = {
  /** 普通信息 */
  info(...args: unknown[]): void {
    console.info(...args)
    window.api.log.write('info', serialize(args))
  },
  /** 警告 */
  warn(...args: unknown[]): void {
    console.warn(...args)
    window.api.log.write('warn', serialize(args))
  },
  /** 错误 */
  error(...args: unknown[]): void {
    console.error(...args)
    window.api.log.write('error', serialize(args))
  },
  /** 调试(只进控制台,不落盘) */
  debug(...args: unknown[]): void {
    console.debug(...args)
  }
}

/** 渲染层全局异常捕获(main.tsx 启动时调用一次) */
export function setupGlobalErrorCapture(): void {
  window.addEventListener('error', (event) => {
    logger.error('[global] 未捕获异常:', event.error ?? event.message)
  })
  window.addEventListener('unhandledrejection', (event) => {
    logger.error('[global] 未处理的 Promise 拒绝:', event.reason)
  })
}
