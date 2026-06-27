// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeApi } from '@shared/types/api'

const appWindow = vi.hoisted(() => ({
  isMaximized: vi.fn(async () => false),
  onMaximizeChanged: vi.fn()
}))

const fileDialog = vi.hoisted(() => ({
  open: vi.fn(async () => ['/tmp/skill'])
}))

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn()
}))

const router = vi.hoisted(() => ({
  navigate: vi.fn(),
  location: { pathname: '/settings' }
}))

const agentWs = vi.hoisted(() => ({
  switchSession: vi.fn(),
  connected: false
}))

vi.mock('@/utils/window', () => ({ appWindow }))
vi.mock('@/utils/dialog', () => ({ fileDialog }))
vi.mock('@/components/Toast', () => ({ toast }))
vi.mock('@/services/agent/runtime-client', () => ({ agentWs }))
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return {
    ...actual,
    useNavigate: () => router.navigate,
    useLocation: () => router.location
  }
})

function installApi(): BridgeApi {
  const api = {
    store: {
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      secureGet: vi.fn(async () => undefined),
      secureSet: vi.fn(async () => undefined),
      secureDelete: vi.fn(async () => undefined)
    },
    db: {
      session: {
        upsert: vi.fn(async () => undefined),
        list: vi.fn(async () => []),
        getMessages: vi.fn(async () => []),
        delete: vi.fn(async () => undefined),
        appendMessage: vi.fn(),
        deleteLastAssistantMessage: vi.fn(),
        updateTitle: vi.fn()
      },
      example: {
        list: vi.fn(),
        add: vi.fn(),
        remove: vi.fn(),
        clear: vi.fn()
      }
    },
    agent: {
      getScope: vi.fn(async () => ({ scope: 'full', workspaceDir: '' })),
      setScope: vi.fn(async () => ({ success: true }))
    },
    agentChat: {
      deleteSession: vi.fn(async () => ({ success: true })),
      send: vi.fn(),
      abort: vi.fn(),
      listSessions: vi.fn(),
      init: vi.fn(),
      onEvent: vi.fn()
    }
  } as unknown as BridgeApi
  window.api = api
  return api
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  installApi()
  router.location.pathname = '/settings'
  document.documentElement.removeAttribute('data-theme')
})

describe('hooks', () => {
  it('useTheme 将 appStore theme 同步到 html[data-theme]', async () => {
    const listeners = new Set<() => void>()
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({
        matches: true,
        addEventListener: (_event: string, cb: () => void) => listeners.add(cb),
        removeEventListener: (_event: string, cb: () => void) => listeners.delete(cb)
      }))
    })
    const [{ useTheme }, { useAppStore }] = await Promise.all([
      import('../useTheme'),
      import('@/stores/appStore')
    ])
    useAppStore.getState().setTheme('system')
    function Probe(): null {
      useTheme()
      return null
    }

    const { unmount } = render(<Probe />)
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'))
    expect(listeners.size).toBe(1)
    unmount()
    expect(listeners.size).toBe(0)
  })

  it('useWindowMaximized 初始化并订阅最大化状态变化', async () => {
    let listener: ((maximized: boolean) => void) | null = null
    const off = vi.fn()
    appWindow.isMaximized.mockResolvedValueOnce(true)
    appWindow.onMaximizeChanged.mockImplementationOnce((cb: (maximized: boolean) => void) => {
      listener = cb
      return off
    })
    const { useWindowMaximized } = await import('../useWindowMaximized')
    function Probe(): React.JSX.Element {
      return <div>{String(useWindowMaximized())}</div>
    }

    const { unmount } = render(<Probe />)
    await screen.findByText('true')
    act(() => listener?.(false))
    expect(screen.getByText('false')).toBeTruthy()
    unmount()
    expect(off).toHaveBeenCalledTimes(1)
  })

  it('useSkillImport 保持下线提示并不调用后端动态导入', async () => {
    const { useSkillImport } = await import('../useSkillImport')
    function Probe(): React.JSX.Element {
      const imp = useSkillImport()
      return <button onClick={() => void imp.handleImport()}>{String(imp.importing)}</button>
    }

    render(<Probe />)
    fireEvent.click(screen.getByText('false'))
    await waitFor(() =>
      expect(fileDialog.open).toHaveBeenCalledWith({
        properties: ['openDirectory'],
        title: '选择技能文件夹(已下线,仅作说明)'
      })
    )
    expect(toast.error).toHaveBeenCalledWith(
      '技能运行时导入已下线,请编辑 src/main/agent/skills/builtin/ 静态登记'
    )
  })

  it('useSessionActions 新建会话后更新本地 store、切换 runtime session 并导航到 chat', async () => {
    const chatId = '00000000-0000-4000-8000-000000000000'
    const randomUUID = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(chatId)
    const { useSessionActions } = await import('../useSessionManager')
    const { useChatStore } = await import('@/stores/chatStore')
    const { useAgentStore } = await import('@/stores/agentStore')

    function Probe(): React.JSX.Element {
      const { handleNewSession } = useSessionActions()
      return <button onClick={() => void handleNewSession()}>new</button>
    }

    render(<Probe />)
    fireEvent.click(screen.getByText('new'))
    await waitFor(() =>
      expect(window.api.db.session.upsert).toHaveBeenCalledWith({
        chatId,
        title: '新对话',
        platform: 'desktop'
      })
    )
    expect(useChatStore.getState().activeChatId).toBe(chatId)
    expect(useAgentStore.getState().currentSessionKey).toBe(chatId)
    expect(agentWs.switchSession).toHaveBeenCalledWith(chatId)
    expect(router.navigate).toHaveBeenCalledWith('/chat')
    randomUUID.mockRestore()
  })
})
