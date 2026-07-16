// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const appWindow = vi.hoisted(() => ({
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn()
}))

const hooks = vi.hoisted(() => ({
  useWindowMaximized: vi.fn(() => false)
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))
vi.mock('@/utils/window', () => ({ appWindow }))
vi.mock('@/utils/platform', () => ({ isMac: false }))
vi.mock('@/hooks', () => hooks)
vi.mock('react-router-dom', () => ({ Outlet: () => <div>Outlet</div> }))
vi.mock('@/utils', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
// Mock storage to prevent window.api.store calls from zustand persist middleware
vi.mock('@/utils/storage', () => ({
  storage: {
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined)
  }
}))

// Mock window.api for stores that use persist middleware (agentStore, userStore, etc.)
beforeEach(() => {
  ;(window as any).api = {
    store: {
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined)
    },
    log: { write: vi.fn() }
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  hooks.useWindowMaximized.mockReturnValue(false)
})

describe('layouts', () => {
  it('TitleBar 在 Windows 模式渲染三键并调用窗口门面', async () => {
    const { TitleBar } = await import('../TitleBar')
    render(<TitleBar />)

    expect(screen.getByText('titlebar.appName')).toBeTruthy()
    fireEvent.click(screen.getByTitle('最小化'))
    fireEvent.click(screen.getByTitle('最大化'))
    fireEvent.click(screen.getByTitle('关闭'))
    expect(appWindow.minimize).toHaveBeenCalledTimes(1)
    expect(appWindow.toggleMaximize).toHaveBeenCalledTimes(1)
    expect(appWindow.close).toHaveBeenCalledTimes(1)
  })

  it('TitleBar 最大化时第二个按钮标题切换为还原', async () => {
    hooks.useWindowMaximized.mockReturnValue(true)
    const { TitleBar } = await import('../TitleBar')
    render(<TitleBar />)
    expect(screen.getByTitle('还原')).toBeTruthy()
  })

  it('AppLayout/MainLayout 组合 TitleBar、侧栏和 Outlet', async () => {
    vi.resetModules()
    vi.doMock('@/layouts/TitleBar', () => ({ TitleBar: () => <div>TitleBar</div> }))
    vi.doMock('@/components/IconSidebar', () => ({ IconSidebar: () => <div>IconSidebar</div> }))
    vi.doMock('react-router-dom', () => ({ Outlet: () => <div>Outlet</div> }))
    const [{ AppLayout }, { MainLayout }] = await Promise.all([
      import('../AppLayout'),
      import('../MainLayout')
    ])

    const { rerender } = render(<AppLayout />)
    expect(screen.getByText('TitleBar')).toBeTruthy()
    expect(screen.getByText('IconSidebar')).toBeTruthy()
    expect(screen.getByText('Outlet')).toBeTruthy()

    rerender(<MainLayout />)
    expect(screen.getByText('TitleBar')).toBeTruthy()
    expect(screen.getByText('Outlet')).toBeTruthy()
  })
})
