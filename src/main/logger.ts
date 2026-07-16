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

  // dev 下父进程/终端断开后 stdout·stderr 管道被关闭,electron-log 的 console
  // transport 仍向其写入会抛 EPIPE。若不吞掉,下面的 uncaughtException handler 会
  // 再经 log.error 写 console -> 再次 EPIPE -> 再进 handler,自激成死循环刷爆日志并
  // 拖垮主进程(实测单次爆发数百条 write EPIPE)。这里直接忽略管道写错误打破循环。
  const ignorePipeError = (err: NodeJS.ErrnoException): void => {
    if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') return
  }
  process.stdout.on('error', ignorePipeError)
  process.stderr.on('error', ignorePipeError)

  // 主进程全局异常捕获,统一汇入日志,避免静默崩溃
  process.on('uncaughtException', (error) => {
    // EPIPE 源于向已关闭管道写日志:再 log.error 会又触发 EPIPE 回到这里,直接忽略。
    if ((error as NodeJS.ErrnoException)?.code === 'EPIPE') return
    log.error('[main] uncaughtException:', error)
  })
  process.on('unhandledRejection', (reason) => {
    log.error('[main] unhandledRejection:', reason)
  })

  log.info(`[main] 应用启动 v${app.getVersion()} (${process.platform})`)
}

export { log }
