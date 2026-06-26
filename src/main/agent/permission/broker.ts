// src/main/agent/permission/broker.ts
import { getScopeConfig } from '../workspace'

/**
 * Agent 工具权限决策中枢(permission broker)
 *
 * 设计意图:scope(full/restricted)是本产品唯一的安全边界,而应用层字符串校验
 * (assertInScope)只能挡"模型不小心",挡不住"模型被 prompt injection 操纵"。
 * 所有越界/高危的工具动作都必须先经此中枢裁决,而非各工具自行其是。
 *
 * 当前阶段(第二段:审批 UI):
 *   - full       → 一律 allow
 *   - restricted → shell 走逐次审批:先查会话级 allowlist,命中放行;
 *                  未命中则经 approver 弹窗向用户请求授权;无 approver 时安全默认 deny。
 *                  fs/web 的越界已由调用方(assertInScope/assertSafeUrl)拦截,到达此处即放行。
 *
 * 演进方向(后续):持久化 allowlist、OS 级沙箱(sandbox-exec / landlock)强制隔离。
 */

/** 受决策管控的动作类型 */
export type PermissionAction =
  | { kind: 'shell'; command: string }
  | { kind: 'fs-read'; path: string }
  | { kind: 'fs-write'; path: string }
  | { kind: 'web'; url: string }

/** 决策上下文:用于审批路由与取消 */
export interface PermissionContext {
  chatId: string
  signal?: AbortSignal
}

/** 决策结果。reason 用于回灌给模型/展示给用户 */
export type PermissionDecision = { allow: true } | { allow: false; reason: string }

/** 用户对一次审批请求的选择 */
export type ApprovalChoice = 'allow_once' | 'allow_session' | 'deny'

/** 向用户请求授权的审批函数(由主进程审批桥注入) */
export type Approver = (req: {
  chatId: string
  action: PermissionAction
  signal?: AbortSignal
}) => Promise<ApprovalChoice>

const ALLOW: PermissionDecision = { allow: true }
const RESTRICTED_DENY_REASON =
  '当前为「受限访问」档,用户拒绝了本次 shell 命令执行。如需放开,请在设置中切换到「完全访问」档。'
const NO_APPROVER_REASON =
  '当前为「受限访问」档,且审批通道不可用,出于安全已拒绝 shell 命令执行。请切换到「完全访问」档或重试。'

let approver: Approver | null = null

/** 注入审批函数(主进程审批桥在 init 时调用);传 null 注销 */
export function setApprover(fn: Approver | null): void {
  approver = fn
}

// ===== 会话级 allowlist:重启即清,限制爆炸半径 =====
// key = chatId, value = 已被「本次会话允许」的程序名集合
const sessionAllow = new Map<string, Set<string>>()

/** 清空某会话(或全部)的 allowlist */
export function clearSessionAllowlist(chatId?: string): void {
  if (chatId) sessionAllow.delete(chatId)
  else sessionAllow.clear()
}

/**
 * 从命令行提取首个程序名,用于 allowlist 比对。
 * 含 shell 控制符(管道/分号/&&/重定向/命令替换等)的复合命令返回 null,
 * 永不走 allowlist 自动放行 —— 防止 `git status && rm -rf ~` 这类借已授权程序夹带。
 */
export function extractProgram(command: string): string | null {
  const cmd = command.trim()
  if (!cmd) return null
  if (/[|&;<>`$(){}\n]/.test(cmd)) return null // 复合/含控制符,不可信任
  const first = cmd.split(/\s+/)[0]
  if (!first || first.includes('=')) return null // 形如 FOO=bar 的环境变量前缀,拒绝
  return first
}

/**
 * 裁决一个工具动作是否放行(异步:可能需要等待用户审批)。
 */
export async function decide(
  action: PermissionAction,
  ctx: PermissionContext
): Promise<PermissionDecision> {
  const { scope } = getScopeConfig()
  if (scope === 'full') return ALLOW

  // ===== restricted 档策略 =====
  if (action.kind !== 'shell') {
    // fs/web 越界已由调用方校验;到达此处即放行
    return ALLOW
  }

  const program = extractProgram(action.command)

  // 1) 会话级 allowlist 命中(仅单一程序的简单命令可命中)→ 放行
  if (program && sessionAllow.get(ctx.chatId)?.has(program)) return ALLOW

  // 2) 无审批通道 → 安全默认拒绝
  if (!approver) return { allow: false, reason: NO_APPROVER_REASON }

  // 3) 请求用户审批
  let choice: ApprovalChoice
  try {
    choice = await approver({ chatId: ctx.chatId, action, signal: ctx.signal })
  } catch {
    return { allow: false, reason: RESTRICTED_DENY_REASON }
  }

  if (choice === 'deny') return { allow: false, reason: RESTRICTED_DENY_REASON }
  if (choice === 'allow_session' && program) {
    let set = sessionAllow.get(ctx.chatId)
    if (!set) {
      set = new Set()
      sessionAllow.set(ctx.chatId, set)
    }
    set.add(program)
  }
  // allow_once / allow_session 均放行本次
  return ALLOW
}
