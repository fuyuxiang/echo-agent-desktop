import { useEffect, useRef } from 'react'
import { Outlet } from 'react-router-dom'
import { TitleBar } from '@/layouts/TitleBar'
import { IconSidebar } from '@/components/IconSidebar'
import { useUserStore } from '@/stores/userStore'
import { useAgentStore } from '@/stores/agentStore'
import { applyServerModelConfigAndStart } from '@/services/model-bootstrap'
import { toast } from '@/components/Toast'
import { logger } from '@/utils'
import styles from './app-layout.module.scss'

export function AppLayout(): React.JSX.Element {
  const isAuthed = useUserStore((s) => s.isAuthed)
  const ready = useAgentStore((s) => s.ready)
  const bootingRef = useRef(false)

  // 应用启动时装配一次原生 AgentRuntime(setReady 后 UI 解除"等待 Agent 连接")。
  // 无论是否登录都应尝试初始化:
  //   1. 本地模型(Ollama)可在未登录时使用
  //   2. 服务器配置的模型需要登录后才能获取
  //   3. 即使初始化失败,也应该 setReady(true),让 UI 可用,在发送消息时再提示配置模型
  useEffect(() => {
    logger.info('[app-layout] useEffect 触发, isAuthed=', isAuthed, 'ready=', ready, 'booting=', bootingRef.current)
    if (ready || bootingRef.current) return
    bootingRef.current = true
    logger.info('[app-layout] 开始装配 agent runtime...')
    applyServerModelConfigAndStart()
      .then((r) => {
        logger.info('[app-layout] agent runtime 装配结果:', r)
        if (!r.ok) {
          logger.warn('[app-layout] agent runtime 装配失败:', r.error)
          // 即使失败也标记为就绪,让用户可以使用 UI,在实际发送消息时再提示
          useAgentStore.getState().setReady(true)
        }
      })
      .catch((e) => {
        logger.error('[app-layout] agent runtime 装配异常:', e)
        // 异常时也标记为就绪
        useAgentStore.getState().setReady(true)
      })
      .finally(() => {
        bootingRef.current = false
      })
  }, [ready]) // 移除 isAuthed 依赖,改为只依赖 ready

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
