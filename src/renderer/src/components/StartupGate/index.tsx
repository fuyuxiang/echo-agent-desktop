import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { ROUTES } from '@/constants'
import { useUserStore } from '@/stores/userStore'
import { logger } from '@/utils'

type GateState = 'checking' | 'ready' | 'need-login'

/**
 * P6 简化版启动守卫: 仅做登录态检查
 * (Python 环境检查 / Agent 拉起已全部下线)
 */
export function StartupGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [state, setState] = useState<GateState>('checking')
  const isAuthed = useUserStore((s) => s.isAuthed)

  useEffect(() => {
    logger.info(`[startup] 启动守卫 isAuthed=${isAuthed}`)
    setState(isAuthed ? 'ready' : 'need-login')
  }, [isAuthed])

  if (state === 'need-login') return <Navigate to={ROUTES.login} replace />
  if (state === 'checking') {
    return (
      <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-tertiary)' }}>
        正在检查登录状态...
      </div>
    )
  }
  return <>{children}</>
}
