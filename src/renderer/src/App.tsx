import { useEffect } from 'react'
import { RouterProvider } from 'react-router-dom'
import { ErrorBoundary } from 'react-error-boundary'
import { router } from '@/router'
import { ToastContainer, toast } from '@/components/Toast'
import { PermissionDialogContainer } from '@/components/PermissionDialog'
import { useTheme } from '@/hooks'
import { useAppStore } from '@/stores/appStore'
import { useAgentScopeStore } from '@/stores/agentScopeStore'
import { appControl, logger } from '@/utils'
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
 * 应用根组件: 主题 + 语言联动 + 错误边界 + 路由 + 全局 Toast + 更新提示
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

  // 更新已下载提示:主进程推送 → 渲染层用原生 confirm 询问 →
  // 用户同意后调 installUpdate() 触发退出安装。
  // 整个过程不臆造 UI,只复用浏览器/系统确认框,避免引入额外弹窗组件。
  useEffect(() => {
    return appControl.onUpdateDownloaded((info) => {
      toast.info(`新版本 ${info.version} 已下载`, 8000)
      if (window.confirm(`新版本 ${info.version} 已下载,是否立即重启安装?`)) {
        void appControl.installUpdate().catch((err) => {
          logger.error('[app] 安装更新失败:', err)
        })
      }
    })
  }, [])

  return (
    <ErrorBoundary
      FallbackComponent={ErrorFallback}
      onError={(error) => logger.error('[app] 渲染异常:', error)}
    >
      <RouterProvider router={router} />
      <ToastContainer />
      <PermissionDialogContainer />
    </ErrorBoundary>
  )
}
