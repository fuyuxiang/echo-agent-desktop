// src/main/ipc/agent.ts
import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import { getScopeConfig, setScopeConfig } from '../agent/workspace'
import type { AgentScopeConfig } from '@shared/types'

/** 注册 agent scope 相关 IPC(Python 运行时生命周期 handler 已移除)。 */
export function registerAgentIpcHandlers(): void {
  ipcMain.handle(IpcChannels.agent.getScope, () => getScopeConfig())

  ipcMain.handle(IpcChannels.agent.setScope, (_e, scope: AgentScopeConfig) => {
    setScopeConfig(scope)
    return { success: true }
  })
}
