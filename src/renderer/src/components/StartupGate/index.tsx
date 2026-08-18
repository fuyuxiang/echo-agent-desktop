import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ROUTES } from '@/constants'
import { isOrgReady, useOrgStore } from '@/stores/orgStore'

const ORG_GATE_BYPASS_PATHS = [ROUTES.settings, ROUTES.knowledge, '/'] as const

/**
 * 启动守卫:组织服务状态确认前不渲染依赖企业服务的工作台。
 * 设置页与本地知识页保持可用,否则用户无法完成企业接入或管理本地文档。
 */
export function StartupGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const init = useOrgStore((s) => s.init)
  const status = useOrgStore((s) => s.status)
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => {
    void init()
  }, [init])

  const canBypass = ORG_GATE_BYPASS_PATHS.some((path) =>
    path === '/' ? location.pathname === '/' :
      location.pathname === path || location.pathname.startsWith(`${path}/`)
  )

  // 设置页需要在未接入时保持可用,用于配置服务器并完成登录。
  if (canBypass || isOrgReady(status)) return <>{children}</>

  if (status === null) return <StartupLoading />

  return <StartupBlocked onOpenSettings={() => navigate(ROUTES.settings)} />
}

function StartupLoading(): React.JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        color: 'var(--text-primary, #1f2937)'
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          style={{ animation: 'startup-gate-spin 1s linear infinite' }}
        >
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
          <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
        <span>正在连接企业知识库...</span>
      </div>
      <style>{'@keyframes startup-gate-spin { to { transform: rotate(360deg); } }'}</style>
    </div>
  )
}

function StartupBlocked({ onOpenSettings }: { onOpenSettings: () => void }): React.JSX.Element {
  return (
    <div
      role="alert"
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        color: 'var(--text-primary, #1f2937)'
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <p style={{ margin: '0 0 16px' }}>请先在设置中接入企业服务器</p>
        <button type="button" onClick={onOpenSettings} style={{ cursor: 'pointer' }}>
          前往设置
        </button>
      </div>
    </div>
  )
}
