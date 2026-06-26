// src/main/agent/tools/scope.ts
import fs from 'node:fs'
import path from 'node:path'
import { storeGet, storeSet } from '../../store'
import { DEFAULT_AGENT_WORKSPACE } from '../../agent-process/constants'
import type { AgentScopeConfig } from '@shared/types'

const KEY_SCOPE = 'agent.scope'
const KEY_WORKSPACE_DIR = 'agent.workspaceDir'

/** 读取作用域配置。无记录默认 full(沿用现状,偏离总设计 restricted-default,见 spec §4.1) */
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
  if (scope === 'restricted' && workspaceDir && fs.existsSync(workspaceDir)) {
    return workspaceDir
  }
  return DEFAULT_AGENT_WORKSPACE
}

/** 校验目标路径是否在当前 scope 允许范围内 */
export function assertInScope(
  targetPath: string
): { ok: true; resolved: string } | { ok: false; reason: string } {
  const { scope } = getScopeConfig()
  const resolved = path.resolve(targetPath)
  if (scope === 'full') return { ok: true, resolved }
  const ws = path.resolve(resolveWorkspace())
  const rel = path.relative(ws, resolved)
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  return inside
    ? { ok: true, resolved }
    : { ok: false, reason: `restricted 档拒绝越界路径: ${resolved}` }
}
