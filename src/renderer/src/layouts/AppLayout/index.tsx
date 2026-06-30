import { useEffect, useRef, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { TitleBar } from '@/layouts/TitleBar'
import { IconSidebar } from '@/components/IconSidebar'
import { useUserStore } from '@/stores/userStore'
import { useAgentStore } from '@/stores/agentStore'
import { applyServerModelConfigAndStart } from '@/services/model-bootstrap'
import {
  startProjectMemorySync,
  stopProjectMemorySync
} from '@/services/project-memory'
import { logger } from '@/utils'
import styles from './app-layout.module.scss'

export function AppLayout(): React.JSX.Element {
  const isAuthed = useUserStore((s) => s.isAuthed)
  const configured = useAgentStore((s) => s.configured)
  const bootingRef = useRef(false)
  // 暂时性失败(网络/超时)后的重试节拍:递增即触发一次重装配
  const [retryTick, setRetryTick] = useState(0)

  // 装配原生 AgentRuntime。ready=UI 可用门(装配/降级/失败兜底后都置位,解除"等待 Agent 连接");
  // configured=runtime 真正装配成功。仅在尚未装配成功时尝试,避免重复装配。
  // 触发时机:首次挂载、登录态变化(未登录→登录可拉到服务器配置)、暂时性失败后的定时重试。
  useEffect(() => {
    if (configured || bootingRef.current) return
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
        useAgentStore.getState().setReady(true)
        retryTimer = setTimeout(() => setRetryTick((t) => t + 1), 15000)
      })
      .finally(() => {
        bootingRef.current = false
      })
    return () => clearTimeout(retryTimer)
  }, [configured, isAuthed, retryTick])

  // 项目记忆双向同步:仅登录后启用(读认知记忆上行 + 拉服务器项目记忆下行镜像)。
  // 登出或卸载时停止定时器,避免无凭据时空跑/请求。
  useEffect(() => {
    if (isAuthed) {
      startProjectMemorySync()
    } else {
      stopProjectMemorySync()
    }
    return () => stopProjectMemorySync()
  }, [isAuthed])

  return (
    <div className={styles.layout}>
      <TitleBar />
      <div className={styles.body}>
        <IconSidebar />
        <section className={styles.workspace}>
          <main className={styles.main}>
            <Outlet />
          </main>
        </section>
      </div>
    </div>
  )
}
