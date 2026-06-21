import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { ROUTES } from '@/constants'
import { useAgentStore } from '@/stores/agentStore'
import { useUserStore } from '@/stores/userStore'
import { applyServerModelConfigAndStart } from '@/services/model-bootstrap'
import { logger } from '@/utils'

type GateState = 'checking' | 'ready' | 'need-onboarding' | 'need-login' | 'bootstrapping' | 'error'

/**
 * 启动守卫: 进入工作台前的就绪检查(方案A)。
 * 顺序:
 * 1. 远程模式 -> 直接放行(用户在设置里自配)
 * 2. 未登录 -> 跳登录页(模型配置/key 需登录后由服务器下发)
 * 3. 本地 Python 环境未装/损坏 -> 跳 Onboarding 安装
 * 4. 环境就绪但 agent 未运行 -> 拉取服务器模型配置, 生成 yaml 并启动 agent
 * 5. 都就绪 -> 放行, 同步端口
 */
export function StartupGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [state, setState] = useState<GateState>('checking')
  const [errorMsg, setErrorMsg] = useState('')
  const connectionMode = useAgentStore((s) => s.connectionMode)
  const isAuthed = useUserStore((s) => s.isAuthed)

  useEffect(() => {
    let cancelled = false

    async function check(): Promise<void> {
      if (connectionMode === 'remote') {
        if (!cancelled) setState('ready')
        return
      }
      if (!isAuthed) {
        if (!cancelled) setState('need-login')
        return
      }

      try {
        const info = await window.api.agent.getEnvInfo()
        if (cancelled) return

        if (info.status !== 'ready') {
          logger.info(`[startup] 本地环境未就绪 (${info.status}),引导安装`)
          setState('need-onboarding')
          return
        }

        // 环境就绪: agent 已在跑则同步端口放行, 否则拉配置启动
        const port = await window.api.agent.getPort()
        if (port) {
          useAgentStore.getState().setLocalPort(port)
          if (!cancelled) setState('ready')
          return
        }

        setState('bootstrapping')
        const result = await applyServerModelConfigAndStart()
        if (cancelled) return
        if (result.ok) {
          setState('ready')
        } else {
          setErrorMsg(result.error ?? '启动失败')
          setState('error')
        }
      } catch (e) {
        logger.error('[startup] 环境检查失败:', e)
        if (!cancelled) setState('need-onboarding')
      }
    }

    check()
    return () => {
      cancelled = true
    }
  }, [connectionMode, isAuthed])

  if (state === 'need-login') return <Navigate to={ROUTES.login} replace />
  if (state === 'need-onboarding') return <Navigate to={ROUTES.onboarding} replace />

  if (state === 'checking' || state === 'bootstrapping') {
    return (
      <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-tertiary)' }}>
        {state === 'bootstrapping' ? '正在配置并启动本地 Agent...' : '正在检查运行环境...'}
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <p style={{ color: '#ef4444' }}>本地 Agent 启动失败</p>
        <p style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>{errorMsg}</p>
        <button
          style={{ marginTop: 16, padding: '8px 16px', cursor: 'pointer' }}
          onClick={() => window.location.reload()}
        >
          重试
        </button>
      </div>
    )
  }

  return <>{children}</>
}

