// src/main/ipc/agent-chat.ts
import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import { getAgentRuntime } from '../agent/runtime-singleton'
import { initAgentRuntime, type RuntimeInitConfig } from '../agent/runtime-singleton'
import { listChatSessions, deleteChatSession } from '../db/dao/session'
import { clearSessionAllowlist } from '../agent/permission/broker'

export function registerAgentChatIpc(): void {
  ipcMain.handle(
    IpcChannels.agentChat.send,
    (_e, opts: { chatId: string; text: string; attachments?: Array<{ id: string; name: string }> }) => {
      const rt = getAgentRuntime()
      if (!rt) {
        console.error('[agent-chat] 发送失败: runtime 未初始化')
        return
      }
      console.log('[agent-chat] 发送消息 chatId=', opts.chatId, 'text=', opts.text.substring(0, 50))
      void rt.send(opts.chatId, opts.text)
    }
  )

  ipcMain.handle(IpcChannels.agentChat.abort, (_e, opts: { chatId: string }) => {
    getAgentRuntime()?.abort(opts.chatId)
  })

  ipcMain.handle(IpcChannels.agentChat.listSessions, () => listChatSessions())

  ipcMain.handle(IpcChannels.agentChat.deleteSession, (_e, opts: { chatId: string }) => {
    deleteChatSession(opts.chatId)
    // 会话删除时清理其权限 allowlist,避免内存残留
    clearSessionAllowlist(opts.chatId)
    return { success: true }
  })

  ipcMain.handle(IpcChannels.agentChat.init, (_e, cfg: RuntimeInitConfig) => {
    initAgentRuntime(cfg)
    return { success: true }
  })
}
