import { useState, useRef } from 'react'
import { useSessionManager } from '@/hooks/useSessionManager'
import { useChatStore } from '@/stores/chatStore'
import { db } from '@/utils/db'
import styles from './session-list.module.scss'

export function SessionList(): React.JSX.Element {
  const {
    sessions,
    activeChatId,
    selectingChatId,
    deletingChatId,
    handleNewSession,
    handleSelectSession,
    handleDeleteSession
  } = useSessionManager()

  const updateSessionTitle = useChatStore((s) => s.updateSessionTitle)
  const [editingChatId, setEditingChatId] = useState('')
  const [editText, setEditText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const startEditing = (chatId: string, currentTitle: string): void => {
    setEditingChatId(chatId)
    setEditText(currentTitle)
    setTimeout(() => inputRef.current?.select(), 0)
  }

  const commitEdit = (): void => {
    if (editingChatId && editText.trim()) {
      const title = editText.trim()
      updateSessionTitle(editingChatId, title)
      void db.session.updateTitle(editingChatId, title)
    }
    setEditingChatId('')
  }

  const handleEditKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitEdit()
    } else if (e.key === 'Escape') {
      setEditingChatId('')
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.title}>历史会话</span>
        <button className={styles.newBtn} onClick={handleNewSession} title="新建会话">
          +
        </button>
      </div>
      <div className={styles.list}>
        {sessions.map((s) => {
          const isActive = activeChatId ? s.chatId === activeChatId : false
          const displayTitle = s.title || '未命名会话'

          return (
            <div
              key={s.chatId}
              className={`${styles.item} ${isActive ? styles.active : ''}`}
              onClick={() => handleSelectSession(s)}
              aria-busy={selectingChatId === s.chatId}
            >
              {editingChatId === s.chatId ? (
                <input
                  ref={inputRef}
                  className={styles.itemTitleInput}
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={handleEditKeyDown}
                  onClick={(e) => e.stopPropagation()}
                  autoFocus
                />
              ) : (
                <span
                  className={styles.itemTitle}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    startEditing(s.chatId, displayTitle)
                  }}
                >
                  {displayTitle}
                </span>
              )}
              <span className={styles.itemMeta}>
                {selectingChatId === s.chatId ? '...' : `${s.messageCount} 条`}
                <button
                  className={styles.deleteBtn}
                  onClick={(e) => handleDeleteSession(s, e)}
                  disabled={deletingChatId === s.chatId}
                  title="删除"
                >
                  ×
                </button>
              </span>
            </div>
          )
        })}
        {sessions.length === 0 && <div className={styles.empty}>暂无会话</div>}
      </div>
    </div>
  )
}
