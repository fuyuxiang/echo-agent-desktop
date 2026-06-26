import { Navigate } from 'react-router-dom'
import { ROUTES } from '@/constants'
import { useUserStore } from '@/stores/userStore'
import { logger } from '@/utils'

/**
 * P6 简化版启动守卫: 仅做登录态检查
 * (Python 环境检查 / Agent 拉起已全部下线)
 *
 * 用户态由 isAuthed 直接派生,避免 setState in effect。
 */
export function StartupGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const isAuthed = useUserStore((s) => s.isAuthed)
  logger.info(`[startup] 启动守卫 isAuthed=${isAuthed}`)

  if (!isAuthed) return <Navigate to={ROUTES.login} replace />
  return <>{children}</>
}
