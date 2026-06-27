import { beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { IpcChannels } from '@shared/ipc-channels'

type Listener = (...args: unknown[]) => void

interface FakeWindow {
  options: Record<string, unknown>
  events: Map<string, Listener>
  webContents: {
    send: ReturnType<typeof vi.fn>
    setWindowOpenHandler: ReturnType<typeof vi.fn>
    openHandler?: (details: { url: string }) => { action: 'deny' }
  }
  on: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  loadFile: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  hide: ReturnType<typeof vi.fn>
  restore: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  isMinimized: ReturnType<typeof vi.fn>
  isVisible: ReturnType<typeof vi.fn>
  isFocused: ReturnType<typeof vi.fn>
}

const electron = vi.hoisted(() => {
  const appListeners = new Map<string, Listener>()
  const createdWindows: FakeWindow[] = []
  const trayEvents = new Map<string, Listener>()
  const icon = {
    isEmpty: vi.fn(() => false),
    resize: vi.fn(() => icon),
    setTemplateImage: vi.fn()
  }
  const emptyIcon = {
    isEmpty: vi.fn(() => true),
    resize: vi.fn(() => emptyIcon),
    setTemplateImage: vi.fn()
  }
  const tray = {
    setToolTip: vi.fn(),
    setContextMenu: vi.fn(),
    on: vi.fn((event: string, handler: Listener) => trayEvents.set(event, handler)),
    destroy: vi.fn()
  }
  const BrowserWindow = vi.fn(function (this: unknown, options: Record<string, unknown>) {
    const events = new Map<string, Listener>()
    const win: FakeWindow = {
      options,
      events,
      webContents: {
        send: vi.fn(),
        setWindowOpenHandler: vi.fn((handler: (details: { url: string }) => { action: 'deny' }) => {
          win.webContents.openHandler = handler
        })
      },
      on: vi.fn((event: string, handler: Listener) => events.set(event, handler)),
      loadURL: vi.fn(),
      loadFile: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      hide: vi.fn(),
      restore: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => false),
      isVisible: vi.fn(() => true),
      isFocused: vi.fn(() => false)
    }
    createdWindows.push(win)
    return win
  })
  return {
    appListeners,
    createdWindows,
    tray,
    trayEvents,
    icon,
    emptyIcon,
    app: {
      isPackaged: false,
      getAppPath: vi.fn(() => os.tmpdir()),
      getVersion: vi.fn(() => '1.0.0'),
      getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
      setLoginItemSettings: vi.fn(),
      isDefaultProtocolClient: vi.fn(() => false),
      setAsDefaultProtocolClient: vi.fn(),
      on: vi.fn((event: string, handler: Listener) => appListeners.set(event, handler)),
      quit: vi.fn()
    },
    BrowserWindow,
    shell: {
      openExternal: vi.fn()
    },
    globalShortcut: {
      register: vi.fn((_accelerator: string, _handler: () => void) => true),
      unregisterAll: vi.fn()
    },
    Menu: {
      buildFromTemplate: vi.fn((template: unknown) => template)
    },
    nativeImage: {
      createFromPath: vi.fn(() => icon),
      createEmpty: vi.fn(() => emptyIcon)
    },
    Tray: vi.fn(function () {
      return tray
    }),
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => true),
      encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`)),
      decryptString: vi.fn((buf: Buffer) => buf.toString().replace(/^enc:/, ''))
    },
    systemPreferences: {
      getMediaAccessStatus: vi.fn(() => 'granted'),
      askForMediaAccess: vi.fn(async () => true)
    }
  }
})

const windowState = vi.hoisted(() => ({
  state: { x: 1, y: 2, width: 1200, height: 800, manage: vi.fn() },
  factory: vi.fn(() => windowState.state)
}))

const toolkit = vi.hoisted(() => ({
  is: { dev: false }
}))

const updater = vi.hoisted(() => ({
  autoUpdater: {
    logger: null as unknown,
    autoDownload: false,
    on: vi.fn(),
    checkForUpdates: vi.fn(async () => ({ updateInfo: { version: '2.0.0' } }))
  }
}))

const log = vi.hoisted(() => ({
  transports: {
    file: { maxSize: 0, level: '' },
    console: { level: '' }
  },
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
}))

const storeMock = vi.hoisted(() => {
  const data = new Map<string, unknown>()
  class FakeStore {
    get(key: string): unknown {
      return data.get(key)
    }
    set(key: string, value: unknown): void {
      data.set(key, value)
    }
    delete(key: string): void {
      data.delete(key)
    }
    clear(): void {
      data.clear()
    }
  }
  return { data, FakeStore }
})

const asrMock = vi.hoisted(() => {
  const stream = {
    acceptWaveform: vi.fn(),
    inputFinished: vi.fn()
  }
  const recognizer = {
    createStream: vi.fn(() => stream),
    isReady: vi.fn(() => false),
    decode: vi.fn(),
    getResult: vi.fn(() => ({ text: 'recognized' })),
    isEndpoint: vi.fn(() => false),
    reset: vi.fn()
  }
  const OnlineRecognizer = vi.fn(function () {
    return recognizer
  })
  return { OnlineRecognizer, recognizer, stream }
})

vi.mock('electron', () => electron)
vi.mock('electron-window-state', () => ({ default: windowState.factory }))
vi.mock('@electron-toolkit/utils', () => toolkit)
vi.mock('electron-updater', () => ({ default: updater }))
vi.mock('electron-log/main', () => ({ default: log }))
vi.mock('electron-store', () => ({ default: storeMock.FakeStore }))
vi.mock('sherpa-onnx-node', () => ({ OnlineRecognizer: asrMock.OnlineRecognizer }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  electron.appListeners.clear()
  electron.createdWindows.length = 0
  electron.trayEvents.clear()
  storeMock.data.clear()
  electron.app.isPackaged = false
  toolkit.is.dev = false
  delete process.env.ELECTRON_RENDERER_URL
  electron.icon.isEmpty.mockReturnValue(false)
  electron.safeStorage.isEncryptionAvailable.mockReturnValue(true)
  electron.safeStorage.decryptString.mockImplementation((buf: Buffer) => buf.toString().replace(/^enc:/, ''))
  asrMock.recognizer.isReady.mockReturnValue(false)
  asrMock.recognizer.getResult.mockReturnValue({ text: 'recognized' })
  asrMock.recognizer.isEndpoint.mockReturnValue(false)
})

describe('window lifecycle', () => {
  it('createMainWindow 创建安全窗口、加载页面并处理窗口事件', async () => {
    const { createMainWindow, getMainWindow } = await import('../window')
    const win = createMainWindow() as unknown as FakeWindow

    expect(electron.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 1200,
        height: 800,
        minWidth: 960,
        webPreferences: expect.objectContaining({
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true
        })
      })
    )
    expect(windowState.state.manage).toHaveBeenCalledWith(win)
    expect(win.loadFile).toHaveBeenCalledWith(expect.stringContaining(path.join('renderer', 'index.html')))

    win.events.get('ready-to-show')?.()
    win.events.get('maximize')?.()
    win.events.get('unmaximize')?.()
    expect(win.show).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).toHaveBeenCalledWith(IpcChannels.window.onMaximizeChanged, true)
    expect(win.webContents.send).toHaveBeenCalledWith(IpcChannels.window.onMaximizeChanged, false)

    expect(win.webContents.openHandler?.({ url: 'https://example.com' })).toEqual({ action: 'deny' })
    expect(electron.shell.openExternal).toHaveBeenCalledWith('https://example.com')
    expect(win.webContents.openHandler?.({ url: 'file:///tmp/a' })).toEqual({ action: 'deny' })

    expect(getMainWindow()).toBe(win)
    win.events.get('closed')?.()
    expect(getMainWindow()).toBeNull()
  })

  it('开发环境加载 renderer URL，show/toggle 复用已有窗口', async () => {
    toolkit.is.dev = true
    process.env.ELECTRON_RENDERER_URL = 'http://127.0.0.1:5173'
    const { createMainWindow, showMainWindow, toggleMainWindow } = await import('../window')
    const win = createMainWindow() as unknown as FakeWindow
    expect(win.loadURL).toHaveBeenCalledWith('http://127.0.0.1:5173')

    win.isMinimized.mockReturnValueOnce(true)
    showMainWindow()
    expect(win.restore).toHaveBeenCalledTimes(1)
    expect(win.focus).toHaveBeenCalledTimes(1)

    win.isVisible.mockReturnValueOnce(true)
    win.isFocused.mockReturnValueOnce(true)
    toggleMainWindow()
    expect(win.hide).toHaveBeenCalledTimes(1)
  })
})

describe('tray/protocol/shortcut/updater/logger', () => {
  it('setupTray 创建托盘菜单，双击显示主窗口，destroyTray 销毁引用', async () => {
    const showMainWindow = vi.fn()
    vi.doMock('../window', () => ({ showMainWindow }))
    const { setupTray, destroyTray } = await import('../tray')

    setupTray()
    expect(electron.nativeImage.createFromPath).toHaveBeenCalledWith(path.join('resources', 'trayTemplate.png'))
    expect(electron.Tray).toHaveBeenCalledWith(electron.icon)
    expect(electron.tray.setToolTip).toHaveBeenCalledWith('Echo Agent')
    expect(electron.Menu.buildFromTemplate).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ label: '显示主窗口' })])
    )

    electron.trayEvents.get('double-click')?.()
    expect(showMainWindow).toHaveBeenCalledTimes(1)

    destroyTray()
    expect(electron.tray.destroy).toHaveBeenCalledTimes(1)
  })

  it('setupTray 在图标缺失时使用空图标占位', async () => {
    electron.icon.isEmpty.mockReturnValueOnce(true)
    const { setupTray } = await import('../tray')
    setupTray()
    expect(electron.nativeImage.createEmpty).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith(
      '[tray] 托盘图标缺失,使用空图标占位:',
      path.join('resources', 'trayTemplate.png')
    )
  })

  it('protocol 注册 echo-agent 协议并处理 deep link', async () => {
    const showMainWindow = vi.fn()
    vi.doMock('../window', () => ({ showMainWindow }))
    const { setupProtocol, handleDeepLink, extractDeepLinkFromArgv } = await import('../protocol')

    setupProtocol()
    expect(electron.app.setAsDefaultProtocolClient).toHaveBeenCalledWith('echo-agent')
    const preventDefault = vi.fn()
    electron.appListeners.get('open-url')?.({ preventDefault }, 'echo-agent://page/chat')
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(showMainWindow).toHaveBeenCalledTimes(1)

    handleDeepLink('echo-agent://manual')
    expect(log.info).toHaveBeenCalledWith('[protocol] 收到 deep link:', 'echo-agent://manual')
    expect(extractDeepLinkFromArgv(['x', 'echo-agent://abc'])).toBe('echo-agent://abc')
    expect(extractDeepLinkFromArgv(['x'])).toBeUndefined()
  })

  it('shortcut 注册全局快捷键并在退出前注销', async () => {
    const toggleMainWindow = vi.fn()
    vi.doMock('../window', () => ({ toggleMainWindow }))
    const { setupShortcuts, unregisterShortcuts } = await import('../shortcut')

    setupShortcuts()
    expect(electron.globalShortcut.register).toHaveBeenCalledWith(
      'CommandOrControl+Shift+E',
      expect.any(Function)
    )
    const handler = electron.globalShortcut.register.mock.calls[0][1] as () => void
    handler()
    expect(toggleMainWindow).toHaveBeenCalledTimes(1)

    unregisterShortcuts()
    expect(electron.globalShortcut.unregisterAll).toHaveBeenCalledTimes(1)
    electron.appListeners.get('will-quit')?.()
    expect(electron.globalShortcut.unregisterAll).toHaveBeenCalledTimes(2)
  })

  it('setupUpdater 和 checkForUpdates 在更新未启用时安全 no-op', async () => {
    const { setupUpdater, checkForUpdates } = await import('../updater')
    setupUpdater()
    expect(updater.autoUpdater.checkForUpdates).not.toHaveBeenCalled()
    await expect(checkForUpdates()).resolves.toBeNull()
  })

  it('setupLogger 配置日志传输并记录启动信息', async () => {
    const { setupLogger } = await import('../logger')
    setupLogger()
    expect(log.transports.file.maxSize).toBe(5 * 1024 * 1024)
    expect(log.transports.file.level).toBe('info')
    expect(log.transports.console.level).toBe('debug')
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('[main] 应用启动 v1.0.0'))
  })
})

describe('store/permission/asr', () => {
  it('store 支持普通配置与 safeStorage 加密配置', async () => {
    const {
      storeGet,
      storeSet,
      storeDelete,
      storeClear,
      secureSet,
      secureGet,
      secureDelete
    } = await import('../store')

    storeSet('theme', 'dark')
    expect(storeGet('theme')).toBe('dark')
    storeDelete('theme')
    expect(storeGet('theme')).toBeUndefined()

    secureSet('token', 'secret')
    expect(electron.safeStorage.encryptString).toHaveBeenCalledWith('secret')
    expect(secureGet('token')).toBe('secret')
    secureDelete('token')
    expect(secureGet('token')).toBeUndefined()

    electron.safeStorage.isEncryptionAvailable.mockReturnValueOnce(false)
    secureSet('plain', 'value')
    expect(log.warn).toHaveBeenCalledWith('[store] safeStorage 不可用,敏感数据降级为明文存储:', 'plain')
    expect(secureGet('plain')).toBe('value')

    secureSet('bad', 'value')
    electron.safeStorage.decryptString.mockImplementationOnce(() => {
      throw new Error('decrypt failed')
    })
    expect(secureGet('bad')).toBeUndefined()
    expect(log.error).toHaveBeenCalledWith('[store] 解密失败(可能换了系统账户):', 'bad', expect.any(Error))

    storeSet('a', 1)
    storeClear()
    expect(storeGet('a')).toBeUndefined()
  })

  it('permission 查询/申请媒体权限并设置开机自启', async () => {
    const {
      checkMediaPermission,
      requestMediaPermission,
      getLoginItemEnabled,
      setLoginItemEnabled
    } = await import('../permission')

    expect(checkMediaPermission('microphone')).toBe('granted')
    await expect(requestMediaPermission('microphone')).resolves.toBe('granted')
    expect(getLoginItemEnabled()).toBe(false)
    setLoginItemEnabled(true)
    expect(electron.app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true })
    expect(log.info).toHaveBeenCalledWith('[permission] 开机自启已设置为:', true)
  })

  it('ASR stream 和 meeting stream 生命周期与 recognizer 对齐', async () => {
    const {
      initASR,
      createStream,
      feedAudio,
      getResult,
      stopStream,
      samplesToMs,
      createMeetingStream,
      feedMeetingAudio,
      pollMeetingStream,
      stopMeetingStream
    } = await import('../asr')

    expect(samplesToMs(16000)).toBe(1000)
    expect(() => createStream()).toThrow('ASR recognizer not initialized')

    initASR()
    expect(asrMock.OnlineRecognizer).toHaveBeenCalledWith(
      expect.objectContaining({
        modelConfig: expect.objectContaining({ provider: 'cpu' }),
        enableEndpoint: true
      })
    )

    const streamId = createStream()
    const samples = new Float32Array([0.1, 0.2])
    feedAudio(streamId, samples)
    expect(asrMock.stream.acceptWaveform).toHaveBeenCalledWith({ sampleRate: 16000, samples })
    expect(getResult(streamId)).toBe('recognized')
    expect(stopStream(streamId)).toBe('recognized')
    expect(asrMock.stream.inputFinished).toHaveBeenCalledTimes(1)
    expect(getResult(streamId)).toBe('')

    asrMock.recognizer.getResult.mockReturnValue({ text: 'segment' })
    asrMock.recognizer.isEndpoint.mockReturnValue(true)
    const meetingStreamId = createMeetingStream()
    feedMeetingAudio(meetingStreamId, new Float32Array(1600))
    const polled = pollMeetingStream(meetingStreamId)
    expect(polled.confirmed).toEqual([{ startMs: 0, endMs: 100, text: 'segment' }])
    expect(polled.partial).toBe('segment')
    expect(asrMock.recognizer.reset).toHaveBeenCalledTimes(1)

    asrMock.recognizer.getResult.mockReturnValue({ text: 'tail' })
    expect(stopMeetingStream(meetingStreamId).confirmed).toEqual([
      { startMs: 100, endMs: 100, text: 'tail' }
    ])
    expect(stopMeetingStream('missing').confirmed).toEqual([])
  })
})
