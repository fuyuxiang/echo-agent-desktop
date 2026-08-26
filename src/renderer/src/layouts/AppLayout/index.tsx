import { useEffect, useRef, useState } from 'react'
import { Outlet, useNavigate } from 'react-router-dom'
import { TitleBar } from '@/layouts/TitleBar'
import { IconSidebar } from '@/components/IconSidebar'
import { RecorderIndicator } from '@/components/RecorderIndicator'
import { useAgentStore } from '@/stores/agentStore'
import { useOrgStore, isOrgReady } from '@/stores/orgStore'
import { applyServerModelConfigAndStart } from '@/services/model-bootstrap'
import { appControl, logger } from '@/utils'
import styles from './app-layout.module.scss'

export function AppLayout(): React.JSX.Element {
  const orgStatus = useOrgStore((s) => s.status)
  const orgStatusReady = orgStatus !== null
  const orgLoggedIn = orgStatus?.loggedIn
  const orgServerUrl = orgStatus?.serverUrl
  const orgInit = useOrgStore((s) => s.init)
  const bootingRef = useRef(false)
  // 暂时性失败(网络/超时)后的重试节拍:递增即触发一次重装配
  const [retryTick, setRetryTick] = useState(0)
  const navigate = useNavigate()

  // 启动时拉一次企业服务状态,后续由主进程推送。
  useEffect(() => {
    void orgInit()
  }, [orgInit])

  // 启动守卫:echo-agent gateway 就绪 + agent store ready 后,
  // 若用户已登录但未接入组织,把"组织知识问答/沉淀"页提示到设置页;
  // 普通聊天不受影响。这里只是诊断日志,真实拦截在页面内做。
  useEffect(() => {
    if (orgStatus?.loggedIn && !isOrgReady(orgStatus)) {
      logger.info('[app-layout] 企业服务未接入,组织知识功能将不可用')
    }
  }, [orgStatus])

  // UI 可用门:组件挂载即解锁,解除"等待 Agent 连接"遮罩。
  // 与 model-bootstrap 解耦——持久化 configured=true 时后者会被守卫短路,
  // 但 ready 仍必须为 true,否则 Chat textarea 会一直 disabled。
  // 这是会话级状态,不持久化,每次冷启动由组件挂载事件触发。
  useEffect(() => {
    useAgentStore.getState().setReady(true)
    // model broker 和 gateway token 都是进程级临时凭证,每次冷启动必须
    // 重新装配；不能相信上一次会话持久化的 configured=true。
    useAgentStore.getState().setConfigured(false)
  }, [])

  // 等 org 状态恢复后装配。每次身份切换都重装,确保企业/本地模型不串用。
  useEffect(() => {
    if (!orgStatusReady || bootingRef.current) return
    bootingRef.current = true
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    applyServerModelConfigAndStart()
      .then((r) => {
        if (!r.ok) logger.warn('[app-layout] agent runtime 装配失败:', r.error)
        // 暂时性失败(网络/超时)且仍未装配:15s 后自动重试,网络恢复即自愈,无需重启
        if (!r.configured && r.retryable) {
          retryTimer = setTimeout(() => setRetryTick((t) => t + 1), 15000)
        }
      })
      .catch((e) => {
        logger.error('[app-layout] agent runtime 装配异常:', e)
        retryTimer = setTimeout(() => setRetryTick((t) => t + 1), 15000)
      })
      .finally(() => {
        bootingRef.current = false
      })
    return () => clearTimeout(retryTimer)
  }, [orgStatusReady, orgLoggedIn, orgServerUrl, retryTick])

  // Deep link(echo-agent://...)唤起时由主进程推送解析后的路径 + query,
  // 这里拼成 hash 路由的完整地址并跳转。主进程已做白名单校验,这里只负责跳转。
  useEffect(() => {
    return appControl.onDeepLink((payload) => {
      const qs = Object.entries(payload.query)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&')
      const target = qs ? `${payload.path}?${qs}` : payload.path
      logger.info('[app-layout] deep link 跳转:', target)
      navigate(target)
    })
  }, [navigate])

  return (
    <div className={styles.layout}>
      <TitleBar />
      <div className={styles.body}>
        <IconSidebar />
        <section className={styles.workspace}>
          {/* 录音指示器挂在布局层而非页面层:跨页面录音不丢失,提供全局停止入口(2026-08 P0-8) */}
          <RecorderIndicator />
          <main className={styles.main}>
            <Outlet />
          </main>
        </section>
      </div>
    </div>
  )
}
