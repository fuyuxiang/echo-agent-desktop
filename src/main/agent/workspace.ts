// src/main/agent/workspace.ts
import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { storeGet, storeSet } from '../store'
import { log } from '../logger'
import type { AgentScopeConfig } from '@shared/types'

const DESKTOP_DATA_DIR = path.join(app.getPath('home'), '.echo-agent-desktop')

/** 完全访问档的默认工作空间 */
export const DEFAULT_AGENT_WORKSPACE = path.join(DESKTOP_DATA_DIR, 'agent-data')

const KEY_SCOPE = 'agent.scope'
const KEY_WORKSPACE_DIR = 'agent.workspaceDir'

/** 读取作用域配置。无记录默认 full(老用户无感迁移) */
export function getScopeConfig(): AgentScopeConfig {
  const scope = storeGet<AgentScopeConfig['scope']>(KEY_SCOPE)
  const workspaceDir = storeGet<string>(KEY_WORKSPACE_DIR)
  return {
    scope: scope === 'restricted' ? 'restricted' : 'full',
    workspaceDir: typeof workspaceDir === 'string' ? workspaceDir : ''
  }
}

/** 写入作用域配置 */
export function setScopeConfig(c: AgentScopeConfig): void {
  storeSet(KEY_SCOPE, c.scope)
  storeSet(KEY_WORKSPACE_DIR, c.workspaceDir)
}

/** 解析当前生效的 workspace 目录 */
export function resolveWorkspace(): string {
  const { scope, workspaceDir } = getScopeConfig()
  if (scope === 'restricted') {
    if (workspaceDir && fs.existsSync(workspaceDir)) return workspaceDir
    log.warn('[scope] restricted 目录无效, 回退默认 workspace:', workspaceDir)
  }
  return DEFAULT_AGENT_WORKSPACE
}
