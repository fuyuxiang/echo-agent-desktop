import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IpcChannels } from '@shared/ipc-channels'

type Listener = (...args: unknown[]) => void

const electron = vi.hoisted(() => {
  const appListeners = new Map<string, Listener>()
  const createdWindows: Array<{ webContents: { send: ReturnType<typeof vi.fn> }; isDestroyed: ReturnType<typeof vi.fn> }> = []
  return {
    appListeners,
    createdWindows,
    app: {
      isDefaultProtocolClient: vi.fn(() => false),
      setAsDefaultProtocolClient: vi.fn(),
      on: vi.fn((event: string, handler: Listener) => appListeners.set(event, handler)),
      quit: vi.fn()
    },
    BrowserWindow: {
      // 用 push 模拟 getAllWindows —— 单元测试构造的窗口都进 createdWindows
      getAllWindows: vi.fn(() => createdWindows)
    }
  }
})

vi.mock('electron', () => electron)

const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
}))
vi.mock('../logger', () => ({ log }))

const windowMod = vi.hoisted(() => ({
  showMainWindow: vi.fn(),
  takePendingDeepLink: vi.fn(() => null)
}))
vi.mock('../window', () => windowMod)

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  electron.createdWindows.length = 0
  windowMod.takePendingDeepLink.mockReturnValue(null)
})

describe('protocol:parseDeepLink', () => {
  it('解析 echo-agent://chat 返回 path=/chat 与空 query', async () => {
    const { parseDeepLink } = await import('../protocol')
    expect(parseDeepLink('echo-agent://chat')).toEqual({ path: '/chat', query: {} })
  })

  it('解析 echo-agent://meeting/abc 返回 path=/meeting/abc', async () => {
    const { parseDeepLink } = await import('../protocol')
    expect(parseDeepLink('echo-agent://meeting/abc')).toEqual({ path: '/meeting/abc', query: {} })
  })

  it('query 字符串正确解析成键值对', async () => {
    const { parseDeepLink } = await import('../protocol')
    expect(parseDeepLink('echo-agent://meeting?id=m-123&from=link')).toEqual({
      path: '/meeting',
      query: { id: 'm-123', from: 'link' }
    })
  })

  it('非白名单路径返回 null,不参与跳转', async () => {
    const { parseDeepLink } = await import('../protocol')
    expect(parseDeepLink('echo-agent://settings/../etc/passwd')).toBeNull()
    expect(parseDeepLink('echo-agent://evil')).toBeNull()
    expect(parseDeepLink('echo-agent://admin/root')).toBeNull()
  })

  it('协议名不匹配时返回 null', async () => {
    const { parseDeepLink } = await import('../protocol')
    expect(parseDeepLink('https://example.com/chat')).toBeNull()
  })

  it('非法 URL 返回 null', async () => {
    const { parseDeepLink } = await import('../protocol')
    expect(parseDeepLink('not a url')).toBeNull()
  })
})

describe('protocol:broadcastDeepLink', () => {
  it('只对未销毁的窗口推送 IpcChannels.app.onDeepLink', async () => {
    const live = { webContents: { send: vi.fn() }, isDestroyed: vi.fn(() => false) }
    const dead = { webContents: { send: vi.fn() }, isDestroyed: vi.fn(() => true) }
    electron.createdWindows.push(live, dead)

    const { broadcastDeepLink } = await import('../protocol')
    broadcastDeepLink({ path: '/chat', query: { id: '1' } })

    expect(live.webContents.send).toHaveBeenCalledWith(IpcChannels.app.onDeepLink, {
      path: '/chat',
      query: { id: '1' }
    })
    expect(dead.webContents.send).not.toHaveBeenCalled()
  })
})

describe('protocol:handleDeepLink', () => {
  it('合法 deep link 推送给所有窗口,并把版本号写入日志', async () => {
    const win = { webContents: { send: vi.fn() }, isDestroyed: vi.fn(() => false) }
    electron.createdWindows.push(win)

    const { handleDeepLink } = await import('../protocol')
    handleDeepLink('echo-agent://chat?id=c1')

    expect(windowMod.showMainWindow).toHaveBeenCalledTimes(1)
    expect(log.info).toHaveBeenCalledWith('[protocol] 收到 deep link:', 'echo-agent://chat?id=c1')
    expect(win.webContents.send).toHaveBeenCalledWith(IpcChannels.app.onDeepLink, {
      path: '/chat',
      query: { id: 'c1' }
    })
  })

  it('非法 deep link 不广播,但仍显示主窗口', async () => {
    const win = { webContents: { send: vi.fn() }, isDestroyed: vi.fn(() => false) }
    electron.createdWindows.push(win)

    const { handleDeepLink } = await import('../protocol')
    handleDeepLink('https://example.com/evil')

    expect(windowMod.showMainWindow).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith('[protocol] deep link 解析失败或路径不合法:', 'https://example.com/evil')
    expect(win.webContents.send).not.toHaveBeenCalled()
  })
})

describe('protocol:takePendingDeepLink', () => {
  it('第二次取走返回 null(只消费一次)', async () => {
    const win = { webContents: { send: vi.fn() }, isDestroyed: vi.fn(() => false) }
    electron.createdWindows.push(win)

    const { handleDeepLink, takePendingDeepLink } = await import('../protocol')
    handleDeepLink('echo-agent://meeting?id=m-1')

    expect(takePendingDeepLink()).toEqual({ path: '/meeting', query: { id: 'm-1' } })
    expect(takePendingDeepLink()).toBeNull()
  })
})

describe('protocol:setupProtocol', () => {
  it('注册默认协议客户端并订阅 open-url 事件', async () => {
    const { setupProtocol } = await import('../protocol')
    setupProtocol()
    expect(electron.app.setAsDefaultProtocolClient).toHaveBeenCalledWith('echo-agent')
    expect(electron.app.on).toHaveBeenCalledWith('open-url', expect.any(Function))
  })
})
