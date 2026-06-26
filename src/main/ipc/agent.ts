// src/main/ipc/agent.ts
import fs from 'node:fs'
import path from 'node:path'
import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import { getScopeConfig, setScopeConfig } from '../agent/workspace'
import type { AgentScopeConfig } from '@shared/types'

/** 注册 agent scope 相关 IPC(Python 运行时生命周期 handler 已移除)。 */
export function registerAgentIpcHandlers(): void {
  ipcMain.handle(IpcChannels.agent.getScope, () => getScopeConfig())

  ipcMain.handle(IpcChannels.agent.setScope, (_e, scope: AgentScopeConfig) => {
    // 校验入参,拒绝渲染层静默提权或注入非法目录
    if (!scope || (scope.scope !== 'full' && scope.scope !== 'restricted')) {
      return { success: false, error: '非法 scope 取值' }
    }
    const dir = typeof scope.workspaceDir === 'string' ? scope.workspaceDir : ''
    if (scope.scope === 'restricted') {
      if (!dir || !path.isAbsolute(dir)) {
        return { success: false, error: 'restricted 档需提供绝对路径工作目录' }
      }
      try {
        if (!fs.statSync(dir).isDirectory()) {
          return { success: false, error: '工作目录不是有效目录' }
        }
      } catch {
        return { success: false, error: '工作目录不存在或不可访问' }
      }
    }
    setScopeConfig({ scope: scope.scope, workspaceDir: dir })
    return { success: true }
  })
}
