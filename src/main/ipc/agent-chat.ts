// src/main/ipc/agent-chat.ts
import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import { getAgentRuntime } from '../agent/runtime-singleton'
import { initAgentRuntime, type RuntimeInitConfig } from '../agent/runtime-singleton'
import { listChatSessions, deleteChatSession } from '../db/dao/session'

export function registerAgentChatIpc(): void {
  ipcMain.handle(
    IpcChannels.agentChat.send,
    (_e, opts: { chatId: string; text: string; attachments?: Array<{ id: string; name: string }> }) => {
      const rt = getAgentRuntime()
      if (!rt) return // 未配置模型: 静默(也可由调用方先校验)
      void rt.send(opts.chatId, opts.text)
    }
  )

  ipcMain.handle(IpcChannels.agentChat.abort, (_e, opts: { chatId: string }) => {
    getAgentRuntime()?.abort(opts.chatId)
  })

  ipcMain.handle(IpcChannels.agentChat.listSessions, () => listChatSessions())

  ipcMain.handle(IpcChannels.agentChat.deleteSession, (_e, opts: { chatId: string }) => {
    deleteChatSession(opts.chatId)
    return { success: true }
  })

  ipcMain.handle(IpcChannels.agentChat.init, (_e, cfg: RuntimeInitConfig) => {
    initAgentRuntime(cfg)
    return { success: true }
  })
}
