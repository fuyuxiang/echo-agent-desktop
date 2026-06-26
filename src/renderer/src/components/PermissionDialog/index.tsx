import { useSyncExternalStore, useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useTranslation } from 'react-i18next'
import type { PermissionRequest, ApprovalChoice } from '@shared/types'
import styles from './permission-dialog.module.scss'

/**
 * Agent 工具权限审批弹窗
 *
 * - 受限档下 shell 命令执行需用户逐次授权
 * - 订阅主进程 agent:permission:request,用户决定后经 respond 回填
 * - 模块级状态(useSyncExternalStore),仿 Toast 模式,<PermissionDialogContainer /> 挂载于 App.tsx
 */

// ===== 模块级状态 =====
let current: PermissionRequest | null = null
const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((fn) => fn())
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
function getSnapshot(): PermissionRequest | null {
  return current
}

function setCurrent(req: PermissionRequest | null): void {
  current = req
  notify()
}

function respond(requestId: string, choice: ApprovalChoice): void {
  void window.api.agentPermission.respond({ requestId, choice })
  setCurrent(null)
}

/** 审批弹窗容器(App.tsx 挂载一次) */
export function PermissionDialogContainer(): React.JSX.Element {
  const req = useSyncExternalStore(subscribe, getSnapshot)
  const { t } = useTranslation()

  // 订阅主进程审批请求(只保留最新一条;前一条未决时被新请求覆盖,旧请求由主进程超时兜底)
  useEffect(() => {
    const off = window.api.agentPermission.onRequest((r) => setCurrent(r))
    return off
  }, [])

  return (
    <AnimatePresence>
      {req && (
        <motion.div
          className={styles.overlay}
          role="dialog"
          aria-modal="true"
          aria-label={t('permission.title')}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <motion.div
            className={styles.dialog}
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.18 }}
          >
            <h3 className={styles.title}>{t('permission.title')}</h3>
            <p className={styles.prompt}>{t('permission.prompt')}</p>
            <pre className={styles.command}>{req.command}</pre>
            <div className={styles.actions}>
              <button
                className={styles.allowBtn}
                onClick={() => respond(req.requestId, 'allow_once')}
              >
                {t('permission.allowOnce')}
              </button>
              {req.program && (
                <button
                  className={styles.sessionBtn}
                  onClick={() => respond(req.requestId, 'allow_session')}
                  title={t('permission.allowSessionHint', { program: req.program })}
                >
                  {t('permission.allowSession', { program: req.program })}
                </button>
              )}
              <button className={styles.denyBtn} onClick={() => respond(req.requestId, 'deny')}>
                {t('permission.deny')}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
