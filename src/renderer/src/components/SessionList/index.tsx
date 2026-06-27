import { useState, useRef, useMemo, useEffect } from 'react'
import { useSessionManager } from '@/hooks/useSessionManager'
import { useChatStore, type ChatSession } from '@/stores/chatStore'
import { db } from '@/utils/db'
import { groupSessions } from './group'
import styles from './session-list.module.scss'

export function SessionList(): React.JSX.Element {
  const {
    sessions,
    activeChatId,
    selectingChatId,
    deletingChatId,
    handleSelectSession,
    handleDeleteSession,
    handleTogglePin
  } = useSessionManager()

  const updateSessionTitle = useChatStore((s) => s.updateSessionTitle)
  const [query, setQuery] = useState('')
  const [editingChatId, setEditingChatId] = useState('')
  const [editText, setEditText] = useState('')
  const [menuChatId, setMenuChatId] = useState('')
  const [confirmingChatId, setConfirmingChatId] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const startEditing = (chatId: string, currentTitle: string): void => {
    setMenuChatId('')
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

  // 点击任意处关闭「⋯」菜单(菜单自身已 stopPropagation)
  useEffect(() => {
    if (!menuChatId) return
    const close = (): void => setMenuChatId('')
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [menuChatId])

  // 标题过滤(大小写不敏感);分组在过滤后进行
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sessions
    return sessions.filter((s) => (s.title || '未命名会话').toLowerCase().includes(q))
  }, [sessions, query])

  const groups = useMemo(() => groupSessions(filtered), [filtered])

  return (
    <div className={styles.container}>
      <div className={styles.searchBar}>
        <SearchIcon />
        <input
          className={styles.searchInput}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索会话"
        />
        {query && (
          <button className={styles.searchClear} onClick={() => setQuery('')} aria-label="清空搜索">
            ×
          </button>
        )}
      </div>
      <div className={styles.list}>
        {groups.map((group) => (
          <div key={group.key} className={styles.group}>
            <div className={styles.groupLabel}>{group.label}</div>
            {group.sessions.map((s) => renderItem(s))}
          </div>
        ))}
        {groups.length === 0 && (
          <div className={styles.empty}>{query ? '没有匹配的会话' : '暂无会话'}</div>
        )}
      </div>
    </div>
  )

  function renderItem(s: ChatSession): React.JSX.Element {
    const isActive = activeChatId ? s.chatId === activeChatId : false
    const displayTitle = s.title || '未命名会话'
    const isEditing = editingChatId === s.chatId
    const isConfirming = confirmingChatId === s.chatId

    return (
      <div
        key={s.chatId}
        className={`${styles.item} ${isActive ? styles.active : ''}`}
        onClick={() => handleSelectSession(s)}
        aria-busy={selectingChatId === s.chatId}
      >
        {s.pinned && <PinIcon className={styles.pinMark} />}
        {isEditing ? (
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
        {!isEditing && !isConfirming && (
          <button
            className={styles.menuBtn}
            onClick={(e) => {
              e.stopPropagation()
              setMenuChatId(menuChatId === s.chatId ? '' : s.chatId)
            }}
            aria-label="更多操作"
          >
            <MoreIcon />
          </button>
        )}
        {menuChatId === s.chatId && !isConfirming && (
          <SessionMenu
            session={s}
            onPin={() => {
              setMenuChatId('')
              void handleTogglePin(s)
            }}
            onRename={() => startEditing(s.chatId, displayTitle)}
            onDelete={() => {
              setMenuChatId('')
              setConfirmingChatId(s.chatId)
            }}
            onClose={() => setMenuChatId('')}
          />
        )}
        {isConfirming && (
          <span className={styles.confirm} onClick={(e) => e.stopPropagation()}>
            <span className={styles.confirmText}>删除?</span>
            <button
              className={styles.confirmYes}
              disabled={deletingChatId === s.chatId}
              onClick={(e) => {
                void handleDeleteSession(s, e)
                setConfirmingChatId('')
              }}
            >
              删除
            </button>
            <button className={styles.confirmNo} onClick={() => setConfirmingChatId('')}>
              取消
            </button>
          </span>
        )}
      </div>
    )
  }
}

interface SessionMenuProps {
  session: ChatSession
  onPin: () => void
  onRename: () => void
  onDelete: () => void
  onClose: () => void
}

function SessionMenu({ session, onPin, onRename, onDelete }: SessionMenuProps): React.JSX.Element {
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation()
    fn()
  }
  return (
    <div className={styles.menu} onClick={(e) => e.stopPropagation()}>
      <button className={styles.menuItem} onClick={stop(onPin)}>
        {session.pinned ? '取消置顶' : '置顶'}
      </button>
      <button className={styles.menuItem} onClick={stop(onRename)}>
        重命名
      </button>
      <button className={`${styles.menuItem} ${styles.menuItemDanger}`} onClick={stop(onDelete)}>
        删除
      </button>
    </div>
  )
}

function SearchIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}

function MoreIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  )
}

function PinIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M16 3l5 5-4 1-3 3-1 5-2-2-3.5 3.5L7 21l1.5-3.5L5 14l2-2 5-1 3-3 1-4z" />
    </svg>
  )
}


