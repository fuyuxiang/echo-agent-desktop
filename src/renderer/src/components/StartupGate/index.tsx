import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import { ROUTES } from '@/constants'
import { isOrgReady, useOrgStore } from '@/stores/orgStore'

const ORG_GATE_BYPASS_PATHS = [ROUTES.settings, ROUTES.knowledge, '/'] as const

/** 用户显式选择"暂不登录,先试试本地模式"后,本会话不再拦截。 */
const SKIP_ORG_KEY = 'startup-gate:skip-org-once'

/**
 * 启动守卫:组织服务状态确认前不渲染依赖企业服务的工作台。
 *
 * 2026-08 P0-1 修复:把拦截从默认行为改为**可选**。
 * - 未配置/未登录企业:默认渲染 children(本地模式),不强制拦截
 * - 用户可在 StartupScreen 选择"暂不登录"显式跳过
 * - 仅在用户主动选择"接入企业"但未完成配置时才拦截(罕见路径)
 * - 设置页与本地知识页始终可用,用于配置或管理本地数据
 */
export function StartupGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const init = useOrgStore((s) => s.init)
  const status = useOrgStore((s) => s.status)
  const location = useLocation()
  const navigate = useNavigate()
  const [skipped, setSkipped] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(SKIP_ORG_KEY) === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    void init()
  }, [init])

  const canBypass = ORG_GATE_BYPASS_PATHS.some((path) =>
    path === '/' ? location.pathname === '/' :
      location.pathname === path || location.pathname.startsWith(`${path}/`)
  )

  // 拦截条件(全部满足才拦截):
  // 1. 不在 bypass 路径
  // 2. 没有显式选择"暂不登录"
  // 3. 组织服务就绪(配置+登录)
  // 默认行为(不满足 3):直接渲染 children —— 本地模式可用
  if (canBypass || skipped || isOrgReady(status)) return <>{children}</>

  if (status === null) return <StartupLoading />

  // 仅当用户明确进入"接入企业"路径但尚未完成配置时才显示引导屏
  return (
    <StartupScreen
      onOpenSettings={() => navigate(ROUTES.settings)}
      onSkipLocal={() => {
        try {
          sessionStorage.setItem(SKIP_ORG_KEY, '1')
        } catch {
          // sessionStorage 可能被禁用(如隐私模式),降级为本次有效
        }
        setSkipped(true)
      }}
    />
  )
}

function StartupScreen({
  onOpenSettings,
  onSkipLocal
}: {
  onOpenSettings: () => void
  onSkipLocal: () => void
}): React.JSX.Element {
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
      <div style={{ textAlign: 'center', maxWidth: 420 }}>
        <p style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>
          检测到企业服务未就绪
        </p>
        <p style={{ margin: '0 0 20px', color: 'var(--text-secondary, #6b7280)' }}>
          你可以选择先在本地模式使用,或前往设置接入企业服务器。
        </p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={onSkipLocal}
            style={{
              padding: '10px 20px',
              borderRadius: 6,
              border: '1px solid var(--color-border)',
              background: 'transparent',
              cursor: 'pointer'
            }}
          >
            暂不登录,先在本地模式使用
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            style={{
              padding: '10px 20px',
              borderRadius: 6,
              border: 'none',
              background: 'var(--color-primary)',
              color: '#fff',
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            前往设置接入企业
          </button>
        </div>
      </div>
    </div>
  )
}

function StartupLoading(): React.JSX.Element {
  const { t } = useTranslation()
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
        <span>{t('startupGate.connecting')}</span>
      </div>
      <style>{'@keyframes startup-gate-spin { to { transform: rotate(360deg); } }'}</style>
    </div>
  )
}
