// src/main/agent/session/SessionManager.ts
import {
  getChatMessages,
  appendChatMessage,
  upsertChatSession,
  listChatSessions,
  deleteChatSession,
  type MessageRow,
  type SessionRow
} from '../../db/dao/session'
import type { ToolCall } from '../providers'

/** 会话并发锁 + abort 控制 + 历史读写门面 */
export class SessionManager {
  private active = new Map<string, AbortController>()

  /** 拿锁: 同 chatId 已在跑则返回 null */
  acquire(chatId: string): AbortController | null {
    if (this.active.has(chatId)) return null
    const ac = new AbortController()
    this.active.set(chatId, ac)
    return ac
  }

  release(chatId: string): void {
    this.active.delete(chatId)
  }

  abort(chatId: string): void {
    this.active.get(chatId)?.abort()
  }

  /** 中止全部在途会话(运行时切换/销毁时调用) */
  abortAll(): void {
    for (const ac of this.active.values()) ac.abort()
  }

  isBusy(chatId: string): boolean {
    return this.active.has(chatId)
  }

  history(chatId: string): MessageRow[] {
    return getChatMessages(chatId)
  }

  appendMessage(input: {
    chatId: string
    role: string
    content: string
    reasoning?: string | null
    toolCalls?: ToolCall[]
    toolCallId?: string
    toolName?: string
  }): MessageRow {
    upsertChatSession({ chatId: input.chatId })
    return appendChatMessage(input)
  }

  listSessions(): SessionRow[] {
    return listChatSessions()
  }

  deleteSession(chatId: string): void {
    deleteChatSession(chatId)
  }
}
