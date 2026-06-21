import log from 'electron-log/main'
import { app } from 'electron'

/**
 * 日志系统(electron-log)
 *
 * - 日志文件位置: userData/logs/main.log,自动轮转(超过 5MB 归档)
 * - 渲染层日志通过 IPC(log:write)汇入,统一落盘
 * - 全局未捕获异常统一记录
 */
export function setupLogger(): void {
  // 文件日志: 5MB 轮转,保留归档
  log.transports.file.maxSize = 5 * 1024 * 1024
  log.transports.file.level = 'info'
  // 控制台日志: 开发期 debug,生产 info
  log.transports.console.level = app.isPackaged ? 'info' : 'debug'

  // 主进程全局异常捕获,统一汇入日志,避免静默崩溃
  process.on('uncaughtException', (error) => {
    log.error('[main] uncaughtException:', error)
  })
  process.on('unhandledRejection', (reason) => {
    log.error('[main] unhandledRejection:', reason)
  })

  log.info(`[main] 应用启动 v${app.getVersion()} (${process.platform})`)
}

export { log }
