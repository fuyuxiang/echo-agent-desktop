import { lazy, Suspense } from 'react'
import { createHashRouter, Navigate, useRouteError } from 'react-router-dom'
import { AppLayout } from '@/layouts/AppLayout'
import { StartupGate } from '@/components/StartupGate'
import { ROUTES } from '@/constants'
import { useUserStore } from '@/stores/userStore'

/**
 * 路由表(HashRouter,适配 Electron file:// 协议)
 *
 * - 页面一律懒加载(lazy),保证首屏速度
 * - 导航跳转引用 constants/ROUTES 常量
 * - 子路由使用相对路径(不含前导 /)
 * - 登录非强制:启动直接进工作台,用户可在使用中随时登录
 * - 仅管理页受 RequireAdmin 守卫(需管理员角色)
 */

const ChatPage = lazy(() => import('@/pages/Chat'))
const KnowledgePage = lazy(() => import('@/pages/Knowledge'))
const SkillsPage = lazy(() => import('@/pages/Skills'))
const ChannelsPage = lazy(() => import('@/pages/Channels'))
const SettingsPage = lazy(() => import('@/pages/Settings'))
// P6: Onboarding 页面已删(Python 环境引导下线)
// const OnboardingPage = lazy(() => import('@/pages/Onboarding'))
const LoginPage = lazy(() => import('@/pages/Login'))
const ExamplePage = lazy(() => import('@/pages/Example'))
const MemoryPage = lazy(() => import('@/pages/Memory'))
const AdminPage = lazy(() => import('@/pages/Admin'))
const MeetingPage = lazy(() => import('@/pages/Meeting'))
const MeetingDetailPage = lazy(() => import('@/pages/Meeting/MeetingDetail'))
// P11 知识库:资料库 + 资料问答(页面实体由 H1 / H3 在后续 task 中创建)
const KbLibraryPage = lazy(() => import('@/pages/KbLibrary'))
const KbQAPage = lazy(() => import('@/pages/KbQA'))

/** 懒加载包装(统一 loading 兜底) */
function lazyLoad(node: React.ReactNode): React.JSX.Element {
  return <Suspense fallback={null}>{node}</Suspense>
}

/**
 * 管理员守卫:非管理员(含未登录)重定向回工作台
 */
function RequireAdmin({ children }: { children: React.ReactNode }): React.JSX.Element {
  const role = useUserStore((s) => s.user?.role)
  if (role !== 'admin') return <Navigate to={ROUTES.chat} replace />
  return <>{children}</>
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
    element: (
      <StartupGate>
        <AppLayout />
      </StartupGate>
    ),
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <Navigate to="chat" replace /> },
      { path: 'chat', element: lazyLoad(<ChatPage />) },
      { path: 'knowledge', element: lazyLoad(<KnowledgePage />) },
      { path: 'skills', element: lazyLoad(<SkillsPage />) },
      { path: 'channels', element: lazyLoad(<ChannelsPage />) },
      { path: 'settings', element: lazyLoad(<SettingsPage />) },
      { path: 'example', element: lazyLoad(<ExamplePage />) },
      { path: 'memory', element: lazyLoad(<MemoryPage />) },
      { path: 'meeting', element: lazyLoad(<MeetingPage />) },
      { path: 'meeting/:id', element: lazyLoad(<MeetingDetailPage />) },
      { path: 'kb-library', element: lazyLoad(<KbLibraryPage />) },
      { path: 'kb-qa', element: lazyLoad(<KbQAPage />) },
      {
        path: 'admin',
        element: (
          <RequireAdmin>{lazyLoad(<AdminPage />)}</RequireAdmin>
        )
      }
    ]
  },
  {
    path: ROUTES.login,
    element: lazyLoad(<LoginPage />)
  }
])
