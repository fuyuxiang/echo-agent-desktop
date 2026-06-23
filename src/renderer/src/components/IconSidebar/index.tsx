import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ROUTES } from '@/constants'
import { SessionList } from '@/components/SessionList'
import { useSessionActions } from '@/hooks/useSessionManager'
import { useUserStore } from '@/stores/userStore'
import { AccountMenu } from './AccountMenu'
import styles from './sidebar.module.scss'
import clsx from 'clsx'

interface NavItem {
  icon: React.ReactNode
  route: string
  label: string
}

const navItems: NavItem[] = [
  { icon: <KnowledgeIcon />, route: ROUTES.knowledge, label: '我的文档' },
  { icon: <MeetingNavIcon />, route: ROUTES.meeting, label: '会议' }
]

export function IconSidebar(): React.JSX.Element {
  const { t } = useTranslation()
  const location = useLocation()
  const navigate = useNavigate()
  const { handleNewSession } = useSessionActions()
  const role = useUserStore((s) => s.user?.role)

  // 记忆区与技能库已并入设置页,侧边栏只保留我的文档入口
  const mainNav: NavItem[] = navItems

  // 管理入口仅对管理员可见;设置已并入账户菜单
  const bottomNav: NavItem[] =
    role === 'admin'
      ? [{ icon: <AdminIcon />, route: ROUTES.admin, label: t('admin.nav') }]
      : []

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
        <AccountMenu />
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

function MeetingNavIcon(): React.JSX.Element {
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
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <path d="M12 19v4" />
      <path d="M8 23h8" />
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
