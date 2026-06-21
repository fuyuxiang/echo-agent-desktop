import { app, globalShortcut } from 'electron'
import { log } from './logger'
import { toggleMainWindow } from './window'

/**
 * 全局快捷键注册中心
 *
 * 当前注册:
 * - CommandOrControl+Shift+E: 显示/隐藏主窗口(全局唤起)
 *
 * 新增快捷键时在 SHORTCUTS 数组中追加即可
 */
const SHORTCUTS: { accelerator: string; description: string; handler: () => void }[] = [
  {
    accelerator: 'CommandOrControl+Shift+E',
    description: '显示/隐藏主窗口',
    handler: () => toggleMainWindow()
  }
]

/** 注册全部全局快捷键(app ready 后调用) */
export function setupShortcuts(): void {
  for (const { accelerator, description, handler } of SHORTCUTS) {
    const ok = globalShortcut.register(accelerator, handler)
    if (!ok) {
      // 注册失败通常是被其他应用占用,记录但不影响启动
      log.warn(`[shortcut] 注册失败(可能被占用): ${accelerator} - ${description}`)
    }
  }
}

/** 注销全部快捷键(退出前调用) */
export function unregisterShortcuts(): void {
  globalShortcut.unregisterAll()
}

app.on('will-quit', () => {
  unregisterShortcuts()
})
