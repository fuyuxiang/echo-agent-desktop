import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ROUTES } from '@/constants'
import { SessionList } from '@/components/SessionList'
import { useSessionActions } from '@/hooks/useSessionManager'
import { useUserStore } from '@/stores/userStore'
import styles from './sidebar.module.scss'
import clsx from 'clsx'

interface NavItem {
  icon: React.ReactNode
  route: string
  label: string
}

const navItems: NavItem[] = [
  { icon: <KnowledgeIcon />, route: ROUTES.knowledge, label: '我的文档' }
]

const bottomItems: NavItem[] = [{ icon: <SettingsIcon />, route: ROUTES.settings, label: '设置' }]

export function IconSidebar(): React.JSX.Element {
  const { t } = useTranslation()
  const location = useLocation()
  const navigate = useNavigate()
  const { handleNewSession } = useSessionActions()
  const role = useUserStore((s) => s.user?.role)
  const isAuthed = useUserStore((s) => s.isAuthed)
  const signOut = useUserStore((s) => s.signOut)

  // 记忆区与技能库已并入设置页,侧边栏只保留我的文档入口
  const mainNav: NavItem[] = navItems

  // 管理入口仅对管理员可见
  const bottomNav: NavItem[] =
    role === 'admin'
      ? [{ icon: <AdminIcon />, route: ROUTES.admin, label: t('admin.nav') }, ...bottomItems]
      : bottomItems

  const renderItem = (item: NavItem): React.JSX.Element => (
    <button
      key={item.route}
      className={clsx(styles.item, location.pathname.startsWith(item.route) && styles.active)}
      onClick={() => navigate(item.route)}
      title={item.label}
    >
      {item.icon}
      <span className={styles.itemLabel}>{item.label}</span>
    </button>
  )

  return (
    <nav className={styles.sidebar}>
      <div className={styles.top}>
        <div className={styles.brand} aria-hidden="true">
          <span className={styles.brandMark}>E</span>
          <span className={styles.brandText}>Echo</span>
        </div>
        <button
          className={clsx(styles.item, styles.newSession)}
          onClick={handleNewSession}
          title="新建会话"
        >
          <NewSessionIcon />
          <span className={styles.itemLabel}>新建会话</span>
        </button>
        <div className={styles.navGroup}>{mainNav.map(renderItem)}</div>
      </div>
      <div className={styles.sessions}>
        <SessionList />
      </div>
      <div className={styles.bottom}>
        {bottomNav.map(renderItem)}
        {isAuthed ? (
          <button className={styles.item} onClick={() => signOut()} title={t('common.logout')}>
            <LogoutIcon />
            <span className={styles.itemLabel}>{t('common.logout')}</span>
          </button>
        ) : (
          <button
            className={styles.item}
            onClick={() => navigate(ROUTES.login)}
            title={t('common.login')}
          >
            <LoginIcon />
            <span className={styles.itemLabel}>{t('common.login')}</span>
          </button>
        )}
      </div>
    </nav>
  )
}

function NewSessionIcon(): React.JSX.Element {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M12 5v14m-7-7h14" />
    </svg>
  )
}

function KnowledgeIcon(): React.JSX.Element {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      <path d="M8 7h8" />
      <path d="M8 11h6" />
    </svg>
  )
}

function AdminIcon(): React.JSX.Element {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

function SettingsIcon(): React.JSX.Element {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

function LogoutIcon(): React.JSX.Element {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  )
}

function LoginIcon(): React.JSX.Element {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
      <path d="M10 17l5-5-5-5" />
      <path d="M15 12H3" />
    </svg>
  )
}
