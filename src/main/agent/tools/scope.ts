// src/main/agent/tools/scope.ts
import path from 'node:path'
import fs from 'node:fs/promises'
// P6: scope 配置来源统一在 agent/workspace.ts;tools/scope.ts 仅承担工具侧 assertInScope
export { getScopeConfig, setScopeConfig, resolveWorkspace, DEFAULT_AGENT_WORKSPACE } from '../workspace'
import { getScopeConfig, resolveWorkspace } from '../workspace'

export type ScopeResult = { ok: true; resolved: string } | { ok: false; reason: string }

/** 解析路径中已存在部分的真实路径(realpath),不存在的尾段原样拼回。
 * 用于在校验前消除符号链接,防止 ws/link -> / 之类的穿越。 */
async function canonicalize(target: string): Promise<string> {
  let prefix = target
  const tail: string[] = []
  // 逐级回退到最近的已存在祖先,对其取 realpath,再把剩余尾段拼回
  for (;;) {
    try {
      const real = await fs.realpath(prefix)
      return tail.length ? path.join(real, ...tail) : real
    } catch {
      const parent = path.dirname(prefix)
      if (parent === prefix) return target // 到根仍不存在,退回词法路径
      tail.unshift(path.basename(prefix))
      prefix = parent
    }
  }
}

/**
 * 校验目标路径是否在当前 scope 允许范围内。
 * - 相对路径以 baseDir(默认当前 workspace)为基准解析,而非进程 cwd。
 * - restricted 档下对路径与 workspace 双双取 realpath 后比较,消除符号链接穿越(M2)。
 */
export async function assertInScope(targetPath: string, baseDir?: string): Promise<ScopeResult> {
  const { scope } = getScopeConfig()
  const base = baseDir || resolveWorkspace()
  const lexical = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(base, targetPath)
  if (scope === 'full') return { ok: true, resolved: lexical }

  // restricted:消除符号链接后再做包含判断
  const resolved = await canonicalize(lexical)
  const ws = await canonicalize(path.resolve(resolveWorkspace()))
  const rel = path.relative(ws, resolved)
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  return inside
    ? { ok: true, resolved }
    : { ok: false, reason: `restricted 档拒绝越界路径: ${resolved}` }
}
