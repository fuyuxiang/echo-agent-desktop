import { useEffect, useRef } from 'react'
import { Outlet } from 'react-router-dom'
import { TitleBar } from '@/layouts/TitleBar'
import { IconSidebar } from '@/components/IconSidebar'
import { useUserStore } from '@/stores/userStore'
import { useAgentStore } from '@/stores/agentStore'
import { applyServerModelConfigAndStart } from '@/services/model-bootstrap'
import { logger } from '@/utils'
import styles from './app-layout.module.scss'

export function AppLayout(): React.JSX.Element {
  const isAuthed = useUserStore((s) => s.isAuthed)
  const ready = useAgentStore((s) => s.ready)
  const bootingRef = useRef(false)

  // 应用启动时装配一次原生 AgentRuntime(setReady 后 UI 解除"等待 Agent 连接")。
  // 无论是否登录都尝试初始化:Ollama 本地模型未登录可用;服务器模型登录后才拿得到配置;
  // 即使失败也 setReady(true) 让 UI 可用,发送消息时再提示配置模型。
  // 依赖 isAuthed:未登录启动后再登录时,重新尝试拉取服务器模型配置。
  useEffect(() => {
    if (ready || bootingRef.current) return
    bootingRef.current = true
    applyServerModelConfigAndStart()
      .then((r) => {
        if (!r.ok) {
          logger.warn('[app-layout] agent runtime 装配失败:', r.error)
          useAgentStore.getState().setReady(true)
        }
      })
      .catch((e) => {
        logger.error('[app-layout] agent runtime 装配异常:', e)
        useAgentStore.getState().setReady(true)
      })
      .finally(() => {
        bootingRef.current = false
      })
  }, [ready, isAuthed])

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
