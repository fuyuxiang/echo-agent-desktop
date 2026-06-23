import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { ROUTES } from '@/constants'
import { useUserStore } from '@/stores/userStore'
import styles from './account-menu.module.scss'

/** 取展示首字母:中文取首字,英文取首字母大写 */
function initialOf(username: string): string {
  const c = username.trim().charAt(0)
  return /[a-z]/i.test(c) ? c.toUpperCase() : c
}

const ROLE_LABEL: Record<string, string> = { admin: '管理员', member: '成员' }

export function AccountMenu(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const user = useUserStore((s) => s.user)
  const isAuthed = useUserStore((s) => s.isAuthed)
  const signOut = useUserStore((s) => s.signOut)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!isAuthed || !user) {
    return (
      <button className={styles.loginBtn} onClick={() => navigate(ROUTES.login)}>
        {t('common.login')}
      </button>
    )
  }

  const initial = initialOf(user.username)
  const meta = [ROLE_LABEL[user.role] ?? user.role, user.groupId ?? undefined]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className={styles.root} ref={rootRef}>
      {open && (
        <div className={styles.menu} role="menu">
          <div className={styles.menuHeader}>
            <span className={styles.avatarLg}>{initial}</span>
            <div className={styles.identity}>
              <span className={styles.name}>{user.username}</span>
              <span className={styles.meta}>{meta}</span>
            </div>
          </div>
          <div className={styles.menuList}>
            <button
              className={styles.menuItem}
              role="menuitem"
              onClick={() => {
                setOpen(false)
                navigate(ROUTES.settings)
              }}
            >
              {t('settings.nav')}
            </button>
            <button
              className={clsx(styles.menuItem, styles.danger)}
              role="menuitem"
              onClick={() => {
                setOpen(false)
                signOut()
              }}
            >
              {t('common.logout')}
            </button>
          </div>
        </div>
      )}
      <button
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.avatar}>{initial}</span>
        <div className={styles.identity}>
          <span className={styles.name}>{user.username}</span>
          <span className={styles.meta}>{ROLE_LABEL[user.role] ?? user.role}</span>
        </div>
      </button>
    </div>
  )
}
