// src/main/agent/permission/approval-bridge.ts
import { BrowserWindow, ipcMain } from 'electron'
import { nanoid } from 'nanoid'
import { IpcChannels } from '@shared/ipc-channels'
import type { PermissionRequest, PermissionResponse, ApprovalChoice } from '@shared/types'
import { log } from '../../logger'
import { setApprover, extractProgram, type Approver } from './broker'

/**
 * 主进程审批桥:把 broker 的 approver 请求转成 IPC 弹窗,等待渲染层用户决定。
 *
 * - pending: requestId -> resolve,渲染层应答或超时/取消时回填。
 * - 超时(默认 2 分钟)、窗口全关、signal abort 三种兜底都按「拒绝」处理,保证不挂起。
 */

const REQUEST_TIMEOUT_MS = 2 * 60_000

interface Pending {
  resolve: (choice: ApprovalChoice) => void
  timer: NodeJS.Timeout
}

const pending = new Map<string, Pending>()

function settle(requestId: string, choice: ApprovalChoice): void {
  const p = pending.get(requestId)
  if (!p) return
  clearTimeout(p.timer)
  pending.delete(requestId)
  p.resolve(choice)
}

const approver: Approver = ({ chatId, action, signal }) => {
  // 目前仅 shell 走审批
  if (action.kind !== 'shell') return Promise.resolve('allow_once')

  const windows = BrowserWindow.getAllWindows()
  if (windows.length === 0) {
    log.warn('[approval] 无可用窗口,审批请求按拒绝处理')
    return Promise.resolve('deny')
  }

  const requestId = nanoid()
  const req: PermissionRequest = {
    requestId,
    chatId,
    kind: 'shell',
    command: action.command,
    program: extractProgram(action.command)
  }

  return new Promise<ApprovalChoice>((resolve) => {
    const timer = setTimeout(() => {
      log.warn('[approval] 审批超时,按拒绝处理:', requestId)
      settle(requestId, 'deny')
    }, REQUEST_TIMEOUT_MS)
    pending.set(requestId, { resolve, timer })

    // 取消(用户中断对话)时按拒绝兜底
    signal?.addEventListener('abort', () => settle(requestId, 'deny'), { once: true })

    for (const win of windows) {
      win.webContents.send(IpcChannels.agentPermission.request, req)
    }
  })
}

let registered = false

/** 注册审批桥:注入 broker.approver + 监听渲染层应答。幂等。 */
export function registerApprovalBridge(): void {
  setApprover(approver)
  if (registered) return
  registered = true
  ipcMain.handle(IpcChannels.agentPermission.respond, (_e, res: PermissionResponse) => {
    if (!res || typeof res.requestId !== 'string') return { ok: false }
    const choice: ApprovalChoice =
      res.choice === 'allow_once' || res.choice === 'allow_session' ? res.choice : 'deny'
    settle(res.requestId, choice)
    return { ok: true }
  })
}
