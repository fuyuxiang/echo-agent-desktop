import { useSyncExternalStore } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { nanoid } from 'nanoid'
import clsx from 'clsx'
import styles from './toast.module.scss'

/**
 * 全局消息提示(Toast)
 *
 * 用法(任意位置,包括非组件代码):
 *   import { toast } from '@/components/Toast'
 *   toast.success('保存成功')
 *   toast.error('网络异常')
 *   toast.info('普通提示', 5000)
 *
 * <ToastContainer /> 已挂载在 App.tsx,业务无需关心
 */

type ToastType = 'success' | 'error' | 'info'

interface ToastItem {
  id: string
  type: ToastType
  message: string
}

// ===== 模块级状态(useSyncExternalStore 订阅,无需 Provider) =====
let toasts: ToastItem[] = []
const listeners = new Set<() => void>()

function notifyListeners(): void {
  listeners.forEach((fn) => fn())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): ToastItem[] {
  return toasts
}

/** 弹出一条提示,duration 毫秒后自动消失 */
function show(type: ToastType, message: string, duration = 3000): void {
  const item: ToastItem = { id: nanoid(), type, message }
  toasts = [...toasts, item]
  notifyListeners()
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== item.id)
    notifyListeners()
  }, duration)
}

export const toast = {
  /** 成功提示(绿色) */
  success: (message: string, duration?: number) => show('success', message, duration),
  /** 错误提示(红色) */
  error: (message: string, duration?: number) => show('error', message, duration),
  /** 普通提示 */
  info: (message: string, duration?: number) => show('info', message, duration)
}

/** Toast 渲染容器(App.tsx 挂载一次) */
export function ToastContainer(): React.JSX.Element {
  const items = useSyncExternalStore(subscribe, getSnapshot)

  return (
    <div className={styles.container}>
      <AnimatePresence>
        {items.map((item) => (
          <motion.div
            key={item.id}
            className={clsx(styles.toast, styles[item.type])}
            initial={{ opacity: 0, y: -16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.96 }}
            transition={{ duration: 0.2 }}
          >
            {item.message}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
