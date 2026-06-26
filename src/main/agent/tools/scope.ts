// src/main/agent/tools/scope.ts
import path from 'node:path'
// P6: scope 配置来源统一在 agent/workspace.ts;tools/scope.ts 仅承担工具侧 assertInScope
export { getScopeConfig, setScopeConfig, resolveWorkspace, DEFAULT_AGENT_WORKSPACE } from '../workspace'
import { getScopeConfig, resolveWorkspace } from '../workspace'

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
