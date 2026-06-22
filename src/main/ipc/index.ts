import { registerAgentIpcHandlers } from './agent'
import { registerAppHandlers } from './app'
import { registerAsrHandlers } from './asr'
import { registerDbHandlers } from './db'
import { registerLogHandlers } from './log'
import { registerMeetingHandlers } from './meeting'
import { registerPermissionHandlers } from './permission'
import { registerStoreHandlers } from './store'
import { registerSystemHandlers } from './system'
import { registerWindowHandlers } from './window'

/**
 * IPC handler 注册中心(app ready 后调用一次)
 * 新增模块时:新建 ipc/xxx.ts 并在此注册
 */
export function registerAllIpcHandlers(): void {
  registerWindowHandlers()
  registerStoreHandlers()
  registerDbHandlers()
  registerPermissionHandlers()
  registerAppHandlers()
  registerSystemHandlers()
  registerLogHandlers()
  registerAgentIpcHandlers()
  registerAsrHandlers()
  registerMeetingHandlers()
}
