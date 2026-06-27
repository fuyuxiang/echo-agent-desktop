// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const appStore = vi.hoisted(() => ({
  language: 'zh-CN'
}))

const agentScopeStore = vi.hoisted(() => ({
  loadScope: vi.fn(async () => undefined)
}))

const i18n = vi.hoisted(() => ({
  language: 'en-US',
  changeLanguage: vi.fn()
}))

const logger = vi.hoisted(() => ({
  error: vi.fn(),
  setupGlobalErrorCapture: vi.fn()
}))

const createRoot = vi.hoisted(() => vi.fn(() => ({ render: vi.fn() })))

vi.mock('@/hooks', () => ({ useTheme: vi.fn() }))
vi.mock('@/router', () => ({ router: {} }))
vi.mock('react-router-dom', () => ({
  RouterProvider: () => <div>RouterProvider</div>
}))
vi.mock('@/components/Toast', () => ({ ToastContainer: () => <div>ToastContainer</div> }))
vi.mock('@/components/PermissionDialog', () => ({
  PermissionDialogContainer: () => <div>PermissionDialogContainer</div>
}))
vi.mock('@/stores/appStore', () => ({
  useAppStore: (selector: (state: { settings: { language: string } }) => string) =>
    selector({ settings: { language: appStore.language } })
}))
vi.mock('@/stores/agentScopeStore', () => ({
  useAgentScopeStore: {
    getState: () => agentScopeStore
  }
}))
vi.mock('@/utils', () => ({ logger }))
vi.mock('@/utils/logger', () => logger)
vi.mock('@/i18n', () => ({ default: i18n }))
vi.mock('react-dom/client', () => ({ default: { createRoot }, createRoot }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  document.body.innerHTML = '<div id="root"></div>'
  appStore.language = 'zh-CN'
  i18n.language = 'en-US'
})

describe('renderer app entry', () => {
  it('App 渲染全局容器并同步语言/加载 scope', async () => {
    const { default: App } = await import('../App')
    render(<App />)

    expect(screen.getByText('RouterProvider')).toBeTruthy()
    expect(screen.getByText('ToastContainer')).toBeTruthy()
    expect(screen.getByText('PermissionDialogContainer')).toBeTruthy()
    expect(i18n.changeLanguage).toHaveBeenCalledWith('zh-CN')
    expect(agentScopeStore.loadScope).toHaveBeenCalledTimes(1)
  })

  it('main.tsx 初始化全局错误捕获并挂载 React root', async () => {
    vi.doMock('../App', () => ({ default: () => <div>AppRoot</div> }))
    await import('../main')
    expect(logger.setupGlobalErrorCapture).toHaveBeenCalledTimes(1)
    expect(createRoot).toHaveBeenCalledWith(document.getElementById('root'))
    const root = createRoot.mock.results[0].value as { render: ReturnType<typeof vi.fn> }
    expect(root.render).toHaveBeenCalledTimes(1)
  })
})
