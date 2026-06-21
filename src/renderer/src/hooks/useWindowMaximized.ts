import { useEffect, useState } from 'react'
import { appWindow } from '@/utils/window'

/**
 * 窗口最大化状态 hook(标题栏按钮图标切换用)
 */
export function useWindowMaximized(): boolean {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    appWindow.isMaximized().then(setMaximized)
    return appWindow.onMaximizeChanged(setMaximized)
  }, [])

  return maximized
}
