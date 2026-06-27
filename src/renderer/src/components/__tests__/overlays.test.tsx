// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeApi } from '@shared/types/api'
import type { PermissionRequest } from '@shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params?.program ? `${key}:${params.program}` : key
  })
}))
vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    )
  }
}))

let permissionHandler: ((req: PermissionRequest) => void) | null = null
const offPermission = vi.fn()

function installApi(): void {
  window.api = {
    agentPermission: {
      onRequest: vi.fn((handler: (req: PermissionRequest) => void) => {
        permissionHandler = handler
        return offPermission
      }),
      respond: vi.fn(async () => ({ ok: true }))
    }
  } as unknown as BridgeApi
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  permissionHandler = null
  installApi()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('overlay components', () => {
  it('ToastContainer 渲染 toast 并在 duration 后移除', async () => {
    vi.useFakeTimers()
    const { toast, ToastContainer } = await import('../Toast')
    render(<ToastContainer />)

    act(() => toast.success('保存成功', 100))
    expect(screen.getByText('保存成功')).toBeTruthy()
    act(() => vi.advanceTimersByTime(100))
    expect(screen.queryByText('保存成功')).toBeNull()
  })

  it('PermissionDialogContainer 订阅审批请求并回填用户选择', async () => {
    const { PermissionDialogContainer } = await import('../PermissionDialog')
    const { unmount } = render(<PermissionDialogContainer />)

    expect(window.api.agentPermission.onRequest).toHaveBeenCalledTimes(1)
    act(() =>
      permissionHandler?.({
        requestId: 'r1',
        chatId: 'c1',
        kind: 'shell',
        command: 'rm -rf /tmp/a',
        program: 'rm'
      })
    )

    expect(screen.getByRole('dialog', { name: 'permission.title' })).toBeTruthy()
    expect(screen.getByText('rm -rf /tmp/a')).toBeTruthy()
    expect(screen.getByText('permission.allowSession:rm')).toBeTruthy()

    fireEvent.click(screen.getByText('permission.allowOnce'))
    expect(window.api.agentPermission.respond).toHaveBeenCalledWith({
      requestId: 'r1',
      choice: 'allow_once'
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    unmount()
    expect(offPermission).toHaveBeenCalledTimes(1)
  })
})
