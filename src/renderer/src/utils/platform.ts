/**
 * 平台判断(同步常量,preload 注入)
 *
 * 用法:
 *   if (isMac) { ... }
 *
 * 兜底: preload 注入失败或非 Electron 环境(单测/浏览器预览)时 window.api 可能缺失,
 * 模块加载期裸访问会抛错导致整个渲染层白屏。此处优雅降级到 navigator/默认值。
 */

function detectPlatform(): { isMac: boolean; isWin: boolean; platform: string } {
  const injected = typeof window !== 'undefined' ? window.api?.platform : undefined
  if (injected) {
    return { isMac: injected.isMac, isWin: injected.isWin, platform: injected.platform }
  }
  // 降级: 从 navigator 粗略推断, 仅用于避免崩溃, 不保证精确
  const ua = typeof navigator !== 'undefined' ? `${navigator.platform} ${navigator.userAgent}` : ''
  const isMac = /Mac/i.test(ua)
  const isWin = /Win/i.test(ua)
  return { isMac, isWin, platform: isMac ? 'darwin' : isWin ? 'win32' : 'unknown' }
}

const detected = detectPlatform()

/** 是否 macOS */
export const isMac = detected.isMac

/** 是否 Windows */
export const isWin = detected.isWin

/** 原始平台标识(darwin / win32 / linux) */
export const platform = detected.platform
