/**
 * 平台判断(同步常量,preload 注入)
 *
 * 用法:
 *   if (isMac) { ... }
 */

/** 是否 macOS */
export const isMac = window.api.platform.isMac

/** 是否 Windows */
export const isWin = window.api.platform.isWin

/** 原始平台标识(darwin / win32 / linux) */
export const platform = window.api.platform.platform
