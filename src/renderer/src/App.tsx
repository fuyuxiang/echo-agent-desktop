import { useEffect } from 'react'
import { RouterProvider } from 'react-router-dom'
import { ErrorBoundary } from 'react-error-boundary'
import { router } from '@/router'
import { ToastContainer } from '@/components/Toast'
import { useTheme } from '@/hooks'
import { useAppStore } from '@/stores/appStore'
import { useAgentScopeStore } from '@/stores/agentScopeStore'
import { logger } from '@/utils'
import i18n from '@/i18n'

/** 页面崩溃兜底 UI(ErrorBoundary 捕获渲染异常) */
function ErrorFallback({ error }: { error: unknown }): React.JSX.Element {
  const message = error instanceof Error ? error.message : String(error)
  return (
    <div style={{ padding: 48, textAlign: 'center', userSelect: 'text' }}>
      <h2>页面出错了</h2>
      <p style={{ color: 'var(--color-text-3)', marginTop: 12 }}>{message}</p>
    </div>
  )
}

/**
 * 应用根组件: 主题 + 语言联动 + 错误边界 + 路由 + 全局 Toast
 */
export default function App(): React.JSX.Element {
  // 主题同步到 html[data-theme]
  useTheme()

  // 语言偏好持久化恢复后同步给 i18n
  const language = useAppStore((s) => s.settings.language)
  useEffect(() => {
    if (i18n.language !== language) {
      i18n.changeLanguage(language)
    }
  }, [language])

  // P6: 加载 scope 配置(Python 状态订阅已移除)
  useEffect(() => {
    void useAgentScopeStore.getState().loadScope()
  }, [])

  return (
    <ErrorBoundary
      FallbackComponent={ErrorFallback}
      onError={(error) => logger.error('[app] 渲染异常:', error)}
    >
      <RouterProvider router={router} />
      <ToastContainer />
    </ErrorBoundary>
  )
}
