import { registerAgentChatIpc } from './agent-chat'
import { registerAgentIpcHandlers } from './agent'
import { registerAgentMemoryIpc } from './agent-memory'
import { registerAgentSkillIpc } from './agent-skill'
import { registerAppHandlers } from './app'
import { registerAsrHandlers } from './asr'
import { registerBackupIpcHandlers } from './backup'
import { registerDbHandlers } from './db'
import { registerEchoAgentIpc } from './echo-agent'
import { registerGatewayIpcHandlers } from './gateway'
import { registerKanbanIpcHandlers } from './kanban'
import { registerLogHandlers } from './log'
import { registerLogsIpcHandlers } from './logs'
import { registerOrgIpc } from './org'
import { registerMeetingHandlers } from './meeting'
import { registerPermissionHandlers } from './permission'
import { registerProfileIpcHandlers } from './profiles'
import { registerProjectMemoryIpc } from './project-memory'
import { registerScheduleIpcHandlers } from './schedules'
import { registerSettingsIpcHandlers } from './settings'
import { registerSoulIpcHandlers } from './soul'
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
  registerAgentMemoryIpc()
  registerAgentSkillIpc()
  registerAgentChatIpc()
  registerApprovalBridge()
  registerEchoAgentIpc(getWindow)
  registerSessionIpcHandlers()
  registerProfileIpcHandlers()
  registerScheduleIpcHandlers()
  registerProjectMemoryIpc()
  registerGatewayIpcHandlers()
  registerKanbanIpcHandlers()
  registerSoulIpcHandlers()
  registerBackupIpcHandlers()
  registerSettingsIpcHandlers()
  registerLogsIpcHandlers()
  registerOrgIpc(getWindow)
}
