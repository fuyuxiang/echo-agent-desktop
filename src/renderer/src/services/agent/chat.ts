// src/renderer/src/services/agent/chat.ts
// P6: 会话管理改走 window.api.agentChat + window.api.db.session,本文件保留空 stub 兼容旧 import
export interface Session {
  chatId: string
  title: string
  createdAt: number
  lastActivity: number
}

export const chatAPI = {
  list: (): Promise<{ sessions: Session[] }> => Promise.resolve({ sessions: [] }),
  delete: (chatId: string): Promise<{ success?: boolean }> =>
    window.api.agentChat.deleteSession(chatId).then(() => ({ success: true }))
}
