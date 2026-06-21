import { useState, useRef } from 'react'
import { useSessionManager } from '@/hooks/useSessionManager'
import { useChatStore } from '@/stores/chatStore'
import styles from './session-list.module.scss'

export function SessionList(): React.JSX.Element {
  const {
    sessions,
    activeSessionViewKey,
    selectingViewKey,
    deletingViewKey,
    handleNewSession,
    handleSelectSession,
    handleDeleteSession
  } = useSessionManager()

  const updateSessionTitle = useChatStore((s) => s.updateSessionTitle)
  const [editingViewKey, setEditingViewKey] = useState('')
  const [editText, setEditText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const startEditing = (viewKey: string, currentTitle: string): void => {
    setEditingViewKey(viewKey)
    setEditText(currentTitle)
    setTimeout(() => inputRef.current?.select(), 0)
  }

  const commitEdit = (): void => {
    if (editingViewKey && editText.trim()) {
      updateSessionTitle(editingViewKey, editText.trim())
    }
    setEditingViewKey('')
  }

  const handleEditKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitEdit()
    } else if (e.key === 'Escape') {
      setEditingViewKey('')
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.title}>会话</span>
        <button className={styles.newBtn} onClick={handleNewSession} title="新会话">
          +
        </button>
      </div>
      <div className={styles.list}>
        {sessions.map((s) => {
          const isActive = activeSessionViewKey ? s.viewKey === activeSessionViewKey : false
          const displayTitle = s.title || s.chatId || s.platform || '未命名会话'

          return (
            <div
              key={s.viewKey}
              className={`${styles.item} ${isActive ? styles.active : ''}`}
              onClick={() => handleSelectSession(s)}
              aria-busy={selectingViewKey === s.viewKey}
            >
              {editingViewKey === s.viewKey ? (
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
                    startEditing(s.viewKey, displayTitle)
                  }}
                >
                  {displayTitle}
                </span>
              )}
              <span className={styles.itemMeta}>
                {selectingViewKey === s.viewKey ? '...' : `${s.messageCount} 条`}
                <button
                  className={styles.deleteBtn}
                  onClick={(e) => handleDeleteSession(s, e)}
                  disabled={deletingViewKey === s.viewKey}
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
