import { lazy, Suspense } from 'react'
import { createHashRouter, Navigate, useRouteError } from 'react-router-dom'
import { AppLayout } from '@/layouts/AppLayout'
import { ROUTES } from '@/constants'

/**
 * 路由表(HashRouter,适配 Electron file:// 协议)
 *
 * - 页面一律懒加载(lazy),保证首屏速度
 * - 导航跳转引用 constants/ROUTES 常量
 * - 子路由使用相对路径(不含前导 /)
 */

const ChatPage = lazy(() => import('@/pages/Chat'))
const KnowledgePage = lazy(() => import('@/pages/Knowledge'))
const SkillsPage = lazy(() => import('@/pages/Skills'))
const ChannelsPage = lazy(() => import('@/pages/Channels'))
const SettingsPage = lazy(() => import('@/pages/Settings'))
const OnboardingPage = lazy(() => import('@/pages/Onboarding'))
const ExamplePage = lazy(() => import('@/pages/Example'))

/** 懒加载包装(统一 loading 兜底) */
function lazyLoad(node: React.ReactNode): React.JSX.Element {
  return <Suspense fallback={null}>{node}</Suspense>
}

function RouteErrorPage(): React.JSX.Element {
  const error = useRouteError() as Error
  return (
    <div style={{ padding: 32, textAlign: 'center' }}>
      <h2 style={{ marginBottom: 16 }}>页面渲染出错</h2>
      <p style={{ color: 'var(--text-secondary)', marginBottom: 16 }}>
        {error?.message ?? '未知错误'}
      </p>
      <button
        onClick={() => window.location.reload()}
        style={{ padding: '8px 16px', cursor: 'pointer' }}
      >
        重新加载
      </button>
    </div>
  )
}

export const router = createHashRouter([
  {
    path: '/',
    element: <AppLayout />,
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <Navigate to="chat" replace /> },
      { path: 'chat', element: lazyLoad(<ChatPage />) },
      { path: 'knowledge', element: lazyLoad(<KnowledgePage />) },
      { path: 'skills', element: lazyLoad(<SkillsPage />) },
      { path: 'channels', element: lazyLoad(<ChannelsPage />) },
      { path: 'settings', element: lazyLoad(<SettingsPage />) },
      { path: 'example', element: lazyLoad(<ExamplePage />) }
    ]
  },
  {
    path: ROUTES.onboarding,
    element: lazyLoad(<OnboardingPage />)
  }
])
