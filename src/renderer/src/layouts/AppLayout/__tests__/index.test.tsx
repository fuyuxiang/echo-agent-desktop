// @vitest-environment jsdom
// AppLayout 启动期 ready 行为单测
//
// 背景(2026-08 P2 修复):Chat 页 textarea 的"等待 Agent 连接"遮罩由
// agentStore.ready 字段控制。原实现把 setReady(true) 完全耦合到
// model-bootstrap 的执行路径,而 AppLayout 守卫会在持久化 configured=true
// 时短路整个 model-bootstrap 调用 → ready 永远为 false → 重启后 UI 假死。
//
// 本测试守住"组件挂载即解锁 UI"的契约,防止后续重构把 ready 与 model-bootstrap
// 再次耦合回去。
import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const setReady = vi.hoisted(() => vi.fn())
const setConfigured = vi.hoisted(() => vi.fn())

const agentState = vi.hoisted(() => ({
  ready: false,
  configured: false
}))

const applyServerModelConfigAndStart = vi.hoisted(() => vi.fn(async () => ({
  ok: true as const,
  configured: false as const,
  retryable: false as const
})))

const orgStoreState = vi.hoisted(() => ({
  status: null as unknown,
  init: vi.fn(async () => undefined)
}))

vi.mock('@/stores/agentStore', () => ({
  // zustand hook:AppLayout 用 selector 读取 configured
  // AppLayout 内部用 useAgentStore.getState().setReady(true) 兜底
  useAgentStore: Object.assign(
    (selector: (s: typeof agentState) => unknown) => selector(agentState),
    { getState: () => ({ setReady, setConfigured }) }
  )
}))

vi.mock('@/stores/orgStore', () => ({
  useOrgStore: (selector: (s: typeof orgStoreState) => unknown) =>
    selector(orgStoreState),
  isOrgReady: vi.fn(() => false)
}))

vi.mock('@/services/model-bootstrap', () => ({
  applyServerModelConfigAndStart
}))

vi.mock('@/layouts/TitleBar', () => ({ TitleBar: () => <div>TitleBar</div> }))
vi.mock('@/components/IconSidebar', () => ({ IconSidebar: () => <div>IconSidebar</div> }))
vi.mock('@/components/RecorderIndicator', () => ({
  RecorderIndicator: () => <div>RecorderIndicator</div>
}))

vi.mock('@/utils', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  appControl: { onDeepLink: vi.fn(() => () => undefined) }
}))

vi.mock('react-router-dom', () => ({
  Outlet: () => <div>Outlet</div>,
  useNavigate: () => vi.fn()
}))

vi.mock('@/utils/storage', () => ({
  storage: {
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined)
  }
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  agentState.ready = false
  agentState.configured = false
  orgStoreState.status = null
  ;(window as unknown as { api: unknown }).api = {
    store: {
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined)
    }
  }
})

describe('AppLayout 启动期 ready 行为', () => {
  it('冷启动总是重置持久化模型状态，但立即解锁 UI', async () => {
    agentState.configured = true
    applyServerModelConfigAndStart.mockClear()
    setReady.mockClear()

    const { AppLayout } = await import('../index')
    render(<AppLayout />)

    await waitFor(() => expect(setReady).toHaveBeenCalledWith(true))
    expect(setConfigured).toHaveBeenCalledWith(false)
    // org 状态尚未恢复时不抢跑模型装配。
    expect(applyServerModelConfigAndStart).not.toHaveBeenCalled()
  })

  it('首次启动 configured=false 时,AppLayout 装配且 ready 被置 true', async () => {
    agentState.configured = false
    orgStoreState.status = { loggedIn: false, serverUrl: '' }
    applyServerModelConfigAndStart.mockClear()
    setReady.mockClear()

    const { AppLayout } = await import('../index')
    render(<AppLayout />)

    await waitFor(() => expect(applyServerModelConfigAndStart).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(setReady).toHaveBeenCalledWith(true))
  })

  it('model-bootstrap 装配异常时,ready 仍必须为 true(失败兜底后均置 true)', async () => {
    agentState.configured = false
    orgStoreState.status = { loggedIn: false, serverUrl: '' }
    applyServerModelConfigAndStart.mockRejectedValueOnce(new Error('boom'))
    setReady.mockClear()

    const { AppLayout } = await import('../index')
    render(<AppLayout />)

    await waitFor(() => expect(setReady).toHaveBeenCalledWith(true))
  })
})
