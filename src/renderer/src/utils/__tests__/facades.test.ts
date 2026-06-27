// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeApi } from '@shared/types/api'

const highlighter = vi.hoisted(() => ({
  loadLanguage: vi.fn(),
  codeToHtml: vi.fn(() => '<pre>ok</pre>')
}))

vi.mock('shiki', () => ({
  createHighlighter: vi.fn(async () => highlighter)
}))

function installApi(): BridgeApi {
  const api = {
    window: {
      minimize: vi.fn(),
      toggleMaximize: vi.fn(),
      close: vi.fn(),
      isMaximized: vi.fn(async () => true),
      setAlwaysOnTop: vi.fn(),
      onMaximizeChanged: vi.fn(() => vi.fn())
    },
    store: {
      get: vi.fn(async () => 'stored'),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      secureGet: vi.fn(async () => 'secret'),
      secureSet: vi.fn(async () => undefined),
      secureDelete: vi.fn(async () => undefined)
    },
    db: {
      example: {
        list: vi.fn(async () => []),
        add: vi.fn(async (content: string) => ({ id: 1, content, createdAt: 10 })),
        remove: vi.fn(async () => undefined),
        clear: vi.fn(async () => undefined)
      },
      session: {
        list: vi.fn(async () => []),
        upsert: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
        getMessages: vi.fn(async () => []),
        appendMessage: vi.fn(async (input: Record<string, unknown>) => ({ id: 1, ...input, createdAt: 10 })),
        deleteLastAssistantMessage: vi.fn(async () => undefined),
        updateTitle: vi.fn(async () => undefined)
      }
    },
    permission: {
      check: vi.fn(async () => 'granted'),
      request: vi.fn(async () => 'granted'),
      getLoginItem: vi.fn(async () => true),
      setLoginItem: vi.fn(async () => undefined)
    },
    app: {
      getVersion: vi.fn(async () => '1.0.0'),
      relaunch: vi.fn(),
      quit: vi.fn(),
      checkForUpdates: vi.fn(async () => null)
    },
    system: {
      notify: vi.fn(async () => undefined),
      clipboardReadText: vi.fn(async () => 'clip'),
      clipboardWriteText: vi.fn(async () => undefined),
      openExternal: vi.fn(async () => undefined),
      showItemInFolder: vi.fn(async () => undefined),
      showOpenDialog: vi.fn(async () => ['/tmp/a']),
      showSaveDialog: vi.fn(async () => '/tmp/out'),
      httpProxy: vi.fn(async () => ({ ok: true, status: 200, body: '{}' }))
    },
    log: {
      write: vi.fn()
    },
    agent: {
      getScope: vi.fn(async () => ({ scope: 'full', workspaceDir: '' })),
      setScope: vi.fn(async () => ({ success: true }))
    },
    asr: {
      start: vi.fn(async () => 's1'),
      feed: vi.fn(async () => undefined),
      getResult: vi.fn(async () => 'text'),
      stop: vi.fn(async () => 'final')
    },
    meeting: {
      start: vi.fn(async () => ({ meetingId: 'm1' })),
      feed: vi.fn(async () => undefined),
      poll: vi.fn(async () => ({ segments: [], partial: '' })),
      stop: vi.fn(async () => ({ meetingId: 'm1', status: 'processing' })),
      diarize: vi.fn(async () => ({ segments: [] })),
      setSummary: vi.fn(async () => undefined),
      list: vi.fn(async () => ({ meetings: [] })),
      get: vi.fn(async () => ({ meeting: null, segments: [], summary: null })),
      remove: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
      markSource: vi.fn(async () => undefined)
    },
    agentChat: {
      send: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      listSessions: vi.fn(async () => []),
      deleteSession: vi.fn(async () => ({ success: true })),
      init: vi.fn(async () => ({ success: true })),
      onEvent: vi.fn(() => vi.fn())
    },
    agentPermission: {
      onRequest: vi.fn(() => vi.fn()),
      respond: vi.fn(async () => ({ ok: true }))
    },
    agentMemory: {
      list: vi.fn(async () => []),
      search: vi.fn(async () => []),
      get: vi.fn(async () => null),
      update: vi.fn(async () => ({ success: true })),
      delete: vi.fn(async () => ({ success: true })),
      stats: vi.fn(async () => ({
        total: 0,
        byTier: { semantic: 0, procedural: 0, archival: 0 },
        byType: { user: 0, environment: 0, procedural: 0 },
        avgConfidence: 0,
        linkCount: 0,
        episodeCount: 0,
        unconsolidatedCount: 0
      }))
    },
    agentSkill: {
      list: vi.fn(async () => []),
      active: vi.fn(async () => []),
      activate: vi.fn(async () => ({ success: true })),
      deactivate: vi.fn(async () => ({ success: true }))
    },
    platform: {
      isMac: false,
      isWin: true,
      platform: 'win32'
    }
  } as unknown as BridgeApi
  window.api = api
  return api
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  document.documentElement.removeAttribute('data-theme')
  installApi()
})

describe('utils facades', () => {
  it('window/app/storage/db/permission/system 门面透传 window.api', async () => {
    const api = window.api
    const [
      { appWindow },
      { appControl },
      { storage },
      { db },
      { permission },
      { clipboard },
      { fileDialog },
      { notify },
      { shellOpen }
    ] = await Promise.all([
      import('../window'),
      import('../app'),
      import('../storage'),
      import('../db'),
      import('../permission'),
      import('../clipboard'),
      import('../dialog'),
      import('../notification'),
      import('../shell')
    ])

    appWindow.minimize()
    appWindow.toggleMaximize()
    appWindow.close()
    appWindow.setAlwaysOnTop(true)
    await expect(appWindow.isMaximized()).resolves.toBe(true)
    const off = vi.fn()
    vi.mocked(api.window.onMaximizeChanged).mockReturnValueOnce(off)
    expect(appWindow.onMaximizeChanged(vi.fn())).toBe(off)
    expect(api.window.setAlwaysOnTop).toHaveBeenCalledWith(true)

    await expect(appControl.getVersion()).resolves.toBe('1.0.0')
    appControl.relaunch()
    appControl.quit()
    await appControl.checkForUpdates()
    expect(api.app.relaunch).toHaveBeenCalledTimes(1)
    expect(api.app.quit).toHaveBeenCalledTimes(1)

    await expect(storage.get('k')).resolves.toBe('stored')
    await storage.set('k', 1)
    await storage.remove('k')
    await storage.clear()
    await expect(storage.secure.get('token')).resolves.toBe('secret')
    await storage.secure.set('token', 'secret')
    await storage.secure.remove('token')
    expect(api.store.set).toHaveBeenCalledWith('k', 1)
    expect(api.store.secureSet).toHaveBeenCalledWith('token', 'secret')

    await db.example.list()
    await db.example.add('row')
    await db.example.remove(1)
    await db.example.clear()
    await db.session.upsert({ chatId: 'c1' })
    await db.session.getMessages('c1')
    await db.session.appendMessage({ chatId: 'c1', role: 'user', content: 'hi' })
    await db.session.deleteLastAssistantMessage('c1')
    await db.session.updateTitle('c1', 'title')
    await db.session.delete('c1')
    expect(api.db.example.add).toHaveBeenCalledWith('row')
    expect(api.db.session.updateTitle).toHaveBeenCalledWith('c1', 'title')

    await permission.check('microphone')
    await permission.request('camera')
    await permission.getLaunchAtLogin()
    await permission.setLaunchAtLogin(true)
    expect(api.permission.setLoginItem).toHaveBeenCalledWith(true)

    await expect(clipboard.readText()).resolves.toBe('clip')
    await clipboard.writeText('clip')
    await fileDialog.open({ title: 'open' })
    await fileDialog.save({ defaultPath: 'a.txt' })
    await notify({ title: 'notice' })
    await shellOpen.external('https://example.com')
    await shellOpen.showInFolder('/tmp/a')
    expect(api.system.showOpenDialog).toHaveBeenCalledWith({
      properties: ['openFile'],
      title: 'open'
    })
  })

  it('logger 序列化渲染层日志并只把 info/warn/error 写入主进程', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const { logger } = await import('../logger')

    logger.info('a', { b: 1 })
    logger.warn('w')
    logger.error(new Error('boom'))
    logger.debug('d')

    expect(info).toHaveBeenCalledWith('a', { b: 1 })
    expect(warn).toHaveBeenCalledWith('w')
    expect(error).toHaveBeenCalledWith(expect.any(Error))
    expect(debug).toHaveBeenCalledWith('d')
    expect(window.api.log.write).toHaveBeenCalledWith('info', 'a {"b":1}')
    expect(window.api.log.write).toHaveBeenCalledWith('warn', 'w')
    expect(window.api.log.write).toHaveBeenCalledWith('error', expect.stringContaining('boom'))
    expect(window.api.log.write).not.toHaveBeenCalledWith('debug', expect.anything())
  })

  it('eventBus、类型判断和格式化工具行为稳定', async () => {
    const [{ eventBus }, is, format] = await Promise.all([
      import('../event-bus'),
      import('../is'),
      import('../format')
    ])
    const handler = vi.fn()
    eventBus.on('example:refresh', handler)
    eventBus.emit('example:refresh')
    eventBus.off('example:refresh', handler)
    eventBus.emit('example:refresh')
    expect(handler).toHaveBeenCalledTimes(1)

    expect(is.isObject({})).toBe(true)
    expect(is.isObject([])).toBe(false)
    expect(is.isFunction(() => undefined)).toBe(true)
    expect(is.isString('x')).toBe(true)
    expect(is.isNumber(Number.NaN)).toBe(false)
    expect(is.isEmpty('   ')).toBe(true)
    expect(is.isEmpty({})).toBe(true)
    expect(is.isHttpUrl('https://example.com')).toBe(true)
    expect(is.isHttpUrl('file:///tmp/a')).toBe(false)

    expect(format.formatFileSize(500)).toBe('500 B')
    expect(format.formatFileSize(1536)).toBe('1.5 KB')
    expect(format.formatNumber(1234567)).toBe('1,234,567')
    expect(format.formatTime(0, 'YYYY')).toBe('1970')
  })

  it('platform 优先使用 preload 注入，缺失时优雅降级', async () => {
    let platformModule = await import('../platform')
    expect(platformModule.platform).toBe('win32')
    expect(platformModule.isWin).toBe(true)

    vi.resetModules()
    Reflect.deleteProperty(window, 'api')
    platformModule = await import('../platform')
    expect(['darwin', 'win32', 'unknown']).toContain(platformModule.platform)
  })

  it('highlightCode 跳过纯文本并缓存高亮器/语言加载', async () => {
    const { highlightCode } = await import('../highlighter')
    await expect(highlightCode('plain', 'text', 'light')).resolves.toBeNull()
    await expect(highlightCode('const a = 1', 'ts', 'dark')).resolves.toBe('<pre>ok</pre>')
    await expect(highlightCode('const b = 2', 'ts', 'light')).resolves.toBe('<pre>ok</pre>')
    expect(highlighter.loadLanguage).toHaveBeenCalledTimes(1)
    expect(highlighter.codeToHtml).toHaveBeenCalledWith('const a = 1', {
      lang: 'ts',
      theme: 'github-dark'
    })
  })
})
