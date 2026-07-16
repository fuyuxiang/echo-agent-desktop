// src/main/ipc/agent-chat.ts
import { ipcMain, BrowserWindow } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import { getGatewayClient } from '../echo-agent'
import type { Frame } from '../echo-agent/gateway-client'
import { listChatSessions, deleteChatSession } from '../db/dao/session'
import { clearSessionAllowlist } from '../agent/permission/broker'
import { generateTitle } from '../echo-agent/title'

function broadcast(ev: Frame): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IpcChannels.agentChat.event, ev)
  }
}

function client() {
  return getGatewayClient(broadcast)
}

export function registerAgentChatIpc(): void {
  ipcMain.handle(
    IpcChannels.agentChat.send,
    (_e, opts: { chatId: string; text: string; attachments?: Array<{ id: string; name: string }> }) => {
      const c = client()
      if (!c) {
        broadcast({ type: 'error', chatId: opts.chatId, message: 'Agent 尚未就绪' })
        return
      }
      c.switchSession(opts.chatId)
      c.send(opts.text, opts.attachments)
    }
  )

  ipcMain.handle(IpcChannels.agentChat.abort, (_e, opts: { chatId: string }) => {
    const c = client()
    if (c) {
      c.abort(opts.chatId)
    }
  })

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
}
