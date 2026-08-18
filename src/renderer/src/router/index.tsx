import { lazy, Suspense } from 'react'
import { createHashRouter, Navigate, useRouteError } from 'react-router-dom'
import { AppLayout } from '@/layouts/AppLayout'
import { StartupGate } from '@/components/StartupGate'
import { ROUTES } from '@/constants'
import { useUserStore } from '@/stores/userStore'
import { isFeatureEnabled } from '@shared/feature-flags'

/**
 * 路由表(HashRouter,适配 Electron file:// 协议)
 *
 * - 页面一律懒加载(lazy),保证首屏速度
 * - 导航跳转引用 constants/ROUTES 常量
 * - 子路由使用相对路径(不含前导 /)
 * - 组织服务未接入时由 StartupGate 拦截,设置页与本地知识页仍可访问
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
const GatewayPage = lazy(() => import('@/pages/Gateway'))
const KanbanPage = lazy(() => import('@/pages/Kanban'))
const SoulPage = lazy(() => import('@/pages/Soul'))
const DiscoverPage = lazy(() => import('@/pages/Discover'))
// 企业版入口:StartupGate 在未接入时拦截依赖组织服务的页面,
// 设置页与本地知识页仍可访问。
const AskPage = lazy(() => import('@/pages/Ask'))
const OrgKnowledgePage = lazy(() => import('@/pages/OrgKnowledge'))
// echo://doc/<id>/page/<n> 引用跳转落地:DocViewer 拉原文/PDF 并按页渲染。
const DocViewerPage = lazy(() => import('@/pages/Knowledge/DocViewer'))

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

/** 暂未实装的入口统一占位文案(2026-08 P1-1) */
function FeatureComingSoon({ name }: { name: string }): React.JSX.Element {
  return (
    <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-secondary)' }}>
      <h2 style={{ marginBottom: 12 }}>{name}</h2>
      <p>该功能即将上线</p>
    </div>
  )
}

/**
 * 路由表。featureFlag=false 的入口:
 * - 路由仍存在(防止链接失效),但渲染 FeatureComingSoon 占位
 * - 入口导航(menu/sidebar)按 flag 隐藏
 *
 * 注:不能用 `<Navigate to=...>` 把未实装入口重定向到别处——这会让用户
 * 怀疑链接是否合法,且无法支持"该功能即将上线"的产品承诺。
 */
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
      {
        path: 'knowledge',
        element: isFeatureEnabled('knowledge')
          ? lazyLoad(<KnowledgePage />)
          : lazyLoad(<FeatureComingSoon name="我的文档" />)
      },
      {
        path: 'knowledge/doc',
        element: isFeatureEnabled('knowledge')
          ? lazyLoad(<DocViewerPage />)
          : lazyLoad(<FeatureComingSoon name="文档查看" />)
      },
      { path: 'skills', element: lazyLoad(<SkillsPage />) },
      { path: 'channels', element: lazyLoad(<ChannelsPage />) },
      { path: 'settings', element: lazyLoad(<SettingsPage />) },
      { path: 'example', element: lazyLoad(<ExamplePage />) },
      { path: 'memory', element: lazyLoad(<MemoryPage />) },
      { path: 'meeting', element: lazyLoad(<MeetingPage />) },
      { path: 'meeting/:id', element: lazyLoad(<MeetingDetailPage />) },
      { path: 'gateway', element: lazyLoad(<GatewayPage />) },
      { path: 'kanban', element: lazyLoad(<KanbanPage />) },
      { path: 'soul', element: lazyLoad(<SoulPage />) },
      { path: 'discover', element: lazyLoad(<DiscoverPage />) },
      { path: 'ask', element: lazyLoad(<AskPage />) },
      { path: 'org-knowledge', element: lazyLoad(<OrgKnowledgePage />) },
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
