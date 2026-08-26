import type { ChatSessionRecord, ChatMessageRecord } from '@shared/types'

/**
 * 本地数据库门面(底层主进程 better-sqlite3)
 *
 * 会话数据经 preload 白名单访问主进程 SQLite。
 */
export const db = {
  /** 本地会话表 DAO */
  session: {
    /** 会话列表(按最近活动倒序) */
    list(): Promise<ChatSessionRecord[]> {
      return window.api.db.session.list()
    },
    /** 确保会话存在 */
    upsert(input: { chatId: string; title?: string | null; platform?: string }): Promise<void> {
      return window.api.db.session.upsert(input)
    },
    /** 删除会话及消息 */
    delete(chatId: string): Promise<void> {
      return window.api.db.session.delete(chatId)
    },
    /** 某会话全部消息 */
    getMessages(chatId: string): Promise<ChatMessageRecord[]> {
      return window.api.db.session.getMessages(chatId)
    },
    /** 追加消息 */
    appendMessage(input: {
      chatId: string
      role: string
      content: string
      reasoning?: string | null
    }): Promise<ChatMessageRecord> {
      return window.api.db.session.appendMessage(input)
    },
    /** 删除最后一条 assistant 消息(重新生成时撤销上一轮回复) */
    deleteLastAssistantMessage(chatId: string): Promise<void> {
      return window.api.db.session.deleteLastAssistantMessage(chatId)
    },
    /** 更新标题 */
    updateTitle(chatId: string, title: string): Promise<void> {
      return window.api.db.session.updateTitle(chatId, title)
    },
    /** 置顶/取消置顶 */
    setPinned(chatId: string, pinned: boolean): Promise<void> {
      return window.api.db.session.setPinned(chatId, pinned)
    }
  }
}
