import { registerAgentChatIpc } from './agent-chat'
import { registerAgentIpcHandlers } from './agent'
import { registerAppHandlers } from './app'
import { registerAsrHandlers } from './asr'
import { registerBackupIpcHandlers } from './backup'
import { registerDbHandlers } from './db'
import { registerEchoAgentIpc } from './echo-agent'
import { registerLogHandlers } from './log'
import { registerLogsIpcHandlers } from './logs'
import { registerOrgIpc } from './org'
import { registerMeetingHandlers } from './meeting'
import { registerPermissionHandlers } from './permission'
import { registerProfileIpcHandlers } from './profiles'
import { registerSettingsIpcHandlers } from './settings'
import { registerStoreHandlers } from './store'
import { registerSystemHandlers } from './system'
import { registerSessionIpcHandlers } from './sessions'
import { registerWindowHandlers } from './window'
import { registerApprovalBridge } from '../agent/permission/approval-bridge'

/**
 * IPC handler 注册中心(app ready 后调用一次)
 * 新增模块时:新建 ipc/xxx.ts 并在此注册
 */
export function registerAllIpcHandlers(getWindow: () => Electron.BrowserWindow | null): void {
  registerWindowHandlers()
  registerStoreHandlers()
  registerDbHandlers()
  registerPermissionHandlers()
  registerAppHandlers(getWindow)
  registerSystemHandlers()
  registerLogHandlers()
  registerAgentIpcHandlers()
  registerAsrHandlers()
  registerMeetingHandlers()
  registerAgentChatIpc()
  registerApprovalBridge()
  registerEchoAgentIpc(getWindow)
  registerSessionIpcHandlers()
  registerProfileIpcHandlers()
  registerBackupIpcHandlers()
  registerSettingsIpcHandlers()
  registerLogsIpcHandlers()
  registerOrgIpc(getWindow)
}
