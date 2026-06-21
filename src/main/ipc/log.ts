import { ipcMain } from 'electron'
import type { LogLevel } from '@shared/types'
import { IpcChannels } from '@shared/ipc-channels'
import { log } from '../logger'

/** 注册日志类 IPC:渲染层日志统一汇入主进程日志文件 */
export function registerLogHandlers(): void {
  ipcMain.on(IpcChannels.log.write, (_e, level: LogLevel, message: string) => {
    log[level](`[renderer] ${message}`)
  })
}
