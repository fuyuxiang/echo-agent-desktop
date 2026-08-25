// src/main/ipc/agent-chat.ts
import { ipcMain, BrowserWindow } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import { getGatewayClient } from '../echo-agent'
import type { Frame } from '../echo-agent/gateway-client'
import { listChatSessions, deleteChatSession } from '../db/dao/session'
import { clearSessionAllowlist } from '../agent/permission/broker'
import { generateTitle } from '../echo-agent/title'

/** 空消息错误:切勿在 send IPC 入口放过空文本(避免幽灵回复)。 */
export class EmptyMessageError extends Error {
  constructor() {
    super('不允许发送空消息')
    this.name = 'EmptyMessageError'
  }
}

function broadcast(ev: Frame): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IpcChannels.agentChat.event, ev)
  }
}

function client() {
  return getGatewayClient(broadcast)
}

export function registerAgentChatIpc(): void {
  // 仅发送文本:守门拒绝空内容;切换会话另走 switchSession IPC。
  ipcMain.handle(
    IpcChannels.agentChat.send,
    (
      _e,
      opts: {
        chatId: string
        text: string
        requestId?: string
        attachments?: Array<{ id: string; name: string }>
      }
    ) => {
      // 守门:空文本直接拒绝,避免幽灵回复和费用浪费。
      if (!opts.text || !opts.text.trim()) {
        throw new EmptyMessageError()
      }
      const c = client()
      if (!c) {
        broadcast({ type: 'error', chatId: opts.chatId, message: 'Agent 尚未就绪' })
        return
      }
      // send 只负责发文本,不再隐式切换会话(防止 UI 切换会话被静默触发 send)。
      c.send(opts.text, opts.attachments, opts.requestId)
    }
  )

  // 独立 switchSession IPC:只切换目标会话,不触发任何文本发送。
  ipcMain.handle(
    IpcChannels.agentChat.switchSession,
    (_e, opts: { chatId: string }) => {
      const c = client()
      if (!c) {
        broadcast({ type: 'error', chatId: opts.chatId, message: 'Agent 尚未就绪' })
        return
      }
      c.switchSession(opts.chatId)
    }
  )

  ipcMain.handle(
    IpcChannels.agentChat.abort,
    (_e, opts: { chatId: string; requestId?: string }) => {
      const c = client()
      if (c) {
        c.abort(opts.chatId, opts.requestId)
      }
    }
  )

  ipcMain.handle(IpcChannels.agentChat.listSessions, () => listChatSessions())

  ipcMain.handle(IpcChannels.agentChat.deleteSession, (_e, opts: { chatId: string }) => {
    deleteChatSession(opts.chatId)
    // 会话删除时清理其权限 allowlist,避免内存残留
    clearSessionAllowlist(opts.chatId)
    return { success: true }
  })

  ipcMain.handle(IpcChannels.agentChat.init, (_e, _cfg: unknown) => {
    // 语义改为确保 gateway client 就绪(实际连接在首次 send 时按 chatId 建立)
    client()
    return { success: true }
  })

  ipcMain.handle(IpcChannels.agentChat.generateTitle, (_e, opts: { firstUserMessage: string }) =>
    generateTitle(opts.firstUserMessage)
  )

  // Skills 桥接(2026-08 echo-agent 迁移):
  // 三个 handler 都把请求打包成 { type: 'skill.*', request_id, name? } 帧,
  // 走 GatewayClient.send(text) 整帧透传(Task 3 在 gateway-client.ts 已支持 skill.* 透传)。
  // 响应(accepted/skill.list_result/error)由 echo-agent 通过 onEvent 反向广播回 renderer,
  // renderer 用 request_id 异步配对,不依赖本 IPC 的返回值。
  // name 必须放进帧 body,不能错放到 send 的 attachments 参数。
  ipcMain.handle(
    IpcChannels.agentChat.sendSkillList,
    (_e, opts: { requestId: string }) => {
      const c = client()
      if (!c) {
        broadcast({ type: 'error', request_id: opts.requestId, message: 'Agent 尚未就绪' })
        return
      }
      const frame = JSON.stringify({ type: 'skill.list', request_id: opts.requestId })
      c.send(frame)
    }
  )

  ipcMain.handle(
    IpcChannels.agentChat.sendSkillEnable,
    (_e, opts: { name: string; requestId: string }) => {
      const c = client()
      if (!c) {
        broadcast({ type: 'error', request_id: opts.requestId, message: 'Agent 尚未就绪' })
        return
      }
      const frame = JSON.stringify({
        type: 'skill.enable',
        name: opts.name,
        request_id: opts.requestId
      })
      c.send(frame)
    }
  )

  ipcMain.handle(
    IpcChannels.agentChat.sendSkillDisable,
    (_e, opts: { name: string; requestId: string }) => {
      const c = client()
      if (!c) {
        broadcast({ type: 'error', request_id: opts.requestId, message: 'Agent 尚未就绪' })
        return
      }
      const frame = JSON.stringify({
        type: 'skill.disable',
        name: opts.name,
        request_id: opts.requestId
      })
      c.send(frame)
    }
  )
}
