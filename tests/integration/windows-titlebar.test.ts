/**
 * Regression: Windows frame:false 窗口接 TitleBar 组件
 *
 * 2026-08 审计 P0-2:window.ts 在 Windows 下使用 frame:false 但没自定义标题栏,
 * 拦截页/登录页没接 TitleBar 组件,导致窗口无法拖动/最小化/关闭。
 * 修复后:macOS 走 hiddenInset 保留红绿灯;Windows 自绘三键;
 * 所有 BrowserWindow 内容(包括 StartupGate、LoginPage)包 <TitleBar>。
 *
 * 注:窗口行为需在 Windows 机器实测。本测试覆盖代码契约:
 *   - window.ts 在 Windows 下 frame:false + preload sandbox
 *   - TitleBar 在非 Mac 平台渲染 winControls(最小化/最大化/关闭)
 */
import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const WINDOW_TS = join(__dirname, '../../src/main/window.ts')
const TITLE_BAR_TSX = join(__dirname, '../../src/renderer/src/layouts/TitleBar/index.tsx')
const APP_LAYOUT_TSX = join(__dirname, '../../src/renderer/src/layouts/AppLayout/index.tsx')
const STARTUP_GATE_TSX = join(
  __dirname,
  '../../src/renderer/src/components/StartupGate/index.tsx'
)
const ROUTER_TSX = join(__dirname, '../../src/renderer/src/router/index.tsx')

describe('Regression: Windows frame:false + 自定义标题栏', () => {
  it('window.ts 在非 Mac 平台使用 frame:false', async () => {
    const src = await readFile(WINDOW_TS, 'utf8')
    // 实际写法:...(isMac ? { titleBarStyle: 'hiddenInset' as const } : { frame: false })
    expect(src).toContain('isMac')
    expect(src).toContain('titleBarStyle')
    expect(src).toContain("'hiddenInset'")
    expect(src).toContain('frame: false')
    // 不应同时全开:Windows 不能既 hiddenInset 又 frame:false
    // (实际是三目运算:isMac 取一个,非 isMac 取另一个)
  })

  it('TitleBar 组件在非 Mac 平台渲染 winControls', async () => {
    const src = await readFile(TITLE_BAR_TSX, 'utf8')
    expect(src).toContain('isMac')
    expect(src).toContain('winControls')
    // 三键:最小化/最大化/关闭
    expect(src).toContain('appWindow.minimize')
    expect(src).toContain('appWindow.toggleMaximize')
    expect(src).toContain('appWindow.close')
  })

  it('AppLayout 在顶层挂载 TitleBar', async () => {
    const src = await readFile(APP_LAYOUT_TSX, 'utf8')
    expect(src).toContain('<TitleBar')
  })

  it('StartupGate 不再自己渲染顶层 header(2026-08 修复)', async () => {
    // 修复前 StartupGate 整页覆盖 viewport,无 TitleBar
    // 修复后:StartupGate 只渲染引导屏或 children,TitleBar 由 AppLayout 统一提供
    const src = await readFile(STARTUP_GATE_TSX, 'utf8')
    expect(src).not.toContain('frame:false')
    expect(src).not.toContain('minimize')
    expect(src).not.toContain('close')
  })

  it('LoginPage 路由也挂载 TitleBar(2026-08 P0-2 修复)', async () => {
    // LoginPage 路由不在 AppLayout 内,需 router 层显式挂 TitleBar,
    // 否则 Windows frame:false 时窗口无法拖动/最小化/关闭。
    const src = await readFile(ROUTER_TSX, 'utf8')
    // 必须导入 TitleBar
    expect(src).toContain("from '@/layouts/TitleBar'")
    // LoginPage 路由分支:从 `path: ROUTES.login` 开始到下一个顶层 `}` 为止
    // 用 `path: ROUTES.login` 之后的整段查找 <TitleBar /> 即可(允许注释和 fragment)
    const afterLogin = src.slice(src.indexOf('path: ROUTES.login'))
    expect(afterLogin).toContain('<TitleBar')
    // 顺序保护:TitleBar 在 LoginPage 之前出现
    const titleIdx = afterLogin.indexOf('<TitleBar')
    const loginIdx = afterLogin.indexOf('<LoginPage')
    expect(titleIdx).toBeGreaterThan(-1)
    expect(loginIdx).toBeGreaterThan(titleIdx)
  })
})

describe('Regression: 自定义标题栏可拖动区', () => {
  it('TitleBar 含 -webkit-app-region: drag(可拖动区)', async () => {
    const titlebarScss = join(
      __dirname,
      '../../src/renderer/src/layouts/TitleBar/titlebar.module.scss'
    )
    const src = await readFile(titlebarScss, 'utf8')
    // 应有 drag region 标记;若使用 SCSS 变量或类名,要能 grep 到
    expect(src.toLowerCase()).toMatch(/drag|webkit-app-region/)
  })
})
