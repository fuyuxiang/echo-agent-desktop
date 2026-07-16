import { registerAgentChatIpc } from './agent-chat'
import { registerAgentIpcHandlers } from './agent'
import { registerAgentMemoryIpc } from './agent-memory'
import { registerAgentSkillIpc } from './agent-skill'
import { registerAppHandlers } from './app'
import { registerAsrHandlers } from './asr'
import { registerDbHandlers } from './db'
import { registerEchoAgentIpc } from './echo-agent'
import { registerLogHandlers } from './log'
import { registerMeetingHandlers } from './meeting'
import { registerPermissionHandlers } from './permission'
import { registerProjectMemoryIpc } from './project-memory'
import { registerStoreHandlers } from './store'
import { registerSystemHandlers } from './system'
import { registerModelIpcHandlers } from './models'
import { registerProviderIpcHandlers } from './providers'
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
  registerAppHandlers()
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
  registerModelIpcHandlers()
  registerProviderIpcHandlers()
  registerProjectMemoryIpc()
}
