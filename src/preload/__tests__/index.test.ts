import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcChannels } from '@shared/ipc-channels'
import type { BridgeApi } from '@shared/types/api'
import type { PermissionRequest } from '@shared/types'

type RendererListener = (_event: unknown, payload: unknown) => void

const electron = vi.hoisted(() => {
  const exposed = new Map<string, unknown>()
  const listeners = new Map<string, RendererListener>()
  return {
    exposed,
    listeners,
    contextBridge: {
      exposeInMainWorld: vi.fn((key: string, api: unknown) => exposed.set(key, api))
    },
    ipcRenderer: {
      send: vi.fn(),
      invoke: vi.fn(async () => undefined),
      on: vi.fn((channel: string, listener: RendererListener) => {
        listeners.set(channel, listener)
      }),
      removeListener: vi.fn()
    }
  }
})

vi.mock('electron', () => ({
  contextBridge: electron.contextBridge,
  ipcRenderer: electron.ipcRenderer
}))

async function loadApi(): Promise<BridgeApi> {
  vi.resetModules()
  electron.exposed.clear()
  await import('../index')
  const api = electron.exposed.get('api')
  if (!api) throw new Error('preload did not expose api')
  return api as BridgeApi
}

beforeEach(() => {
  electron.listeners.clear()
  vi.clearAllMocks()
})

describe('preload bridge', () => {
  it('暴露完整 api 分组和平台信息', async () => {
    const api = await loadApi()

    expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledWith('api', api)
    expect(Object.keys(api).sort()).toEqual([
      'agent',
      'agentChat',
      'agentPermission',
      'app',
      'asr',
      'backup',
      'db',
      'echoAgent',
      'echoConfig',
      'log',
      'logs',
      'meeting',
      'org',
      'permission',
      'platform',
      'profiles',
      'sessions',
      'settings',
      'store',
      'system',
      'window'
    ])
    expect(api.platform.platform).toBe(process.platform)
    expect(api.platform.isMac).toBe(process.platform === 'darwin')
    expect(api.platform.isWin).toBe(process.platform === 'win32')
  })

  it('window/app/log 桥接到 send/invoke 并正确解绑事件', async () => {
    const api = await loadApi()
    const onMaximize = vi.fn()

    api.window.minimize()
    api.window.toggleMaximize()
    api.window.close()
    api.window.setAlwaysOnTop(true)
    await api.window.isMaximized()
    const off = api.window.onMaximizeChanged(onMaximize)
    electron.listeners.get(IpcChannels.window.onMaximizeChanged)?.({}, true)
    off()

    expect(electron.ipcRenderer.send).toHaveBeenCalledWith(IpcChannels.window.minimize)
    expect(electron.ipcRenderer.send).toHaveBeenCalledWith(IpcChannels.window.toggleMaximize)
    expect(electron.ipcRenderer.send).toHaveBeenCalledWith(IpcChannels.window.close)
    expect(electron.ipcRenderer.send).toHaveBeenCalledWith(IpcChannels.window.setAlwaysOnTop, true)
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.window.isMaximized)
    expect(onMaximize).toHaveBeenCalledWith(true)
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(
      IpcChannels.window.onMaximizeChanged,
      expect.any(Function)
    )

    await api.app.getVersion()
    api.app.relaunch()
    api.app.quit()
    await api.app.checkForUpdates()
    api.log.write('warn', 'message')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.app.getVersion)
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.app.checkForUpdates)
    expect(electron.ipcRenderer.send).toHaveBeenCalledWith(IpcChannels.app.relaunch)
    expect(electron.ipcRenderer.send).toHaveBeenCalledWith(IpcChannels.app.quit)
    expect(electron.ipcRenderer.send).toHaveBeenCalledWith(IpcChannels.log.write, 'warn', 'message')
  })

  it('echo-agent 方法使用对应 IPC channel', async () => {
    const api = await loadApi()
    const onStatus = vi.fn()

    await api.echoAgent.getStatus()
    await api.echoAgent.getVersion()
    await api.echoAgent.update()
    const off = api.echoAgent.onStatusChanged(onStatus)
    electron.listeners.get(IpcChannels.echoAgent.statusChanged)?.({}, { phase: 'ready' })
    off()

    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.echoAgent.getStatus)
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.echoAgent.getVersion)
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.echoAgent.update)
    expect(onStatus).toHaveBeenCalledWith({ phase: 'ready' })
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(
      IpcChannels.echoAgent.statusChanged,
      expect.any(Function)
    )
  })

  it('store/db/permission/system/agent/asr/meeting 方法使用对应 IPC channel', async () => {
    const api = await loadApi()

    await api.store.get('k')
    await api.store.set('k', 1)
    await api.store.delete('k')
    await api.store.clear()
    await api.store.secureGet('token')
    await api.store.secureSet('token', 'secret')
    await api.store.secureDelete('token')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.store.get, 'k')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.store.set, 'k', 1)
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.store.delete, 'k')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.store.clear)
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.store.secureGet, 'token')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.store.secureSet, 'token', 'secret')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.store.secureDelete, 'token')

    await api.db.session.list()
    await api.db.session.upsert({ chatId: 'c1' })
    await api.db.session.delete('c1')
    await api.db.session.getMessages('c1')
    await api.db.session.appendMessage({ chatId: 'c1', role: 'user', content: 'hi' })
    await api.db.session.deleteLastAssistantMessage('c1')
    await api.db.session.updateTitle('c1', 'title')
    await api.db.session.setPinned('c1', true)
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.db.sessionAppendMessage, {
      chatId: 'c1',
      role: 'user',
      content: 'hi'
    })
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.db.sessionUpdateTitle, 'c1', 'title')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.db.sessionSetPinned, 'c1', true)

    await api.permission.check('microphone')
    await api.permission.request('camera')
    await api.permission.getLoginItem()
    await api.permission.setLoginItem(true)
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.permission.check, 'microphone')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.permission.request, 'camera')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.permission.getLoginItem)
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.permission.setLoginItem, true)

    await api.system.notify({ title: 't' })
    await api.system.clipboardReadText()
    await api.system.clipboardWriteText('clip')
    await api.system.openExternal('https://example.com')
    await api.system.showItemInFolder('/tmp/a')
    await api.system.showOpenDialog({ properties: ['openFile'] })
    await api.system.showSaveDialog({ defaultPath: 'a.txt' })
    await api.system.ollamaRequest({ baseUrl: 'http://localhost:11434', path: '/api/tags' })
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.system.ollamaRequest, {
      baseUrl: 'http://localhost:11434', path: '/api/tags'
    })

    await api.agent.getScope()
    await api.agent.setScope({ scope: 'full', workspaceDir: '' })
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.agent.getScope)
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.agent.setScope, {
      scope: 'full',
      workspaceDir: ''
    })

    const samples = new Float32Array([0.1])
    await api.asr.start()
    await api.asr.feed('s1', samples)
    await api.asr.getResult('s1')
    await api.asr.stop('s1')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.asr.feed, 's1', samples)

    await api.meeting.start()
    await api.meeting.feed('m1', samples)
    await api.meeting.poll('m1')
    await api.meeting.stop('m1')
    await api.meeting.diarize('m1')
    await api.meeting.setSummary('m1', { summary: 's', keyPoints: [], actionItems: [] })
    await api.meeting.list()
    await api.meeting.get('m1')
    await api.meeting.remove('m1')
    await api.meeting.rename('m1', 'title')
    await api.meeting.markSource('m1', 'mic+system')
    await api.meeting.summarize('m1', 'title', [])
    expect(typeof api.meeting.summarize).toBe('function')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.meeting.rename, 'm1', 'title')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.meeting.markSource, 'm1', 'mic+system')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.meeting.summarize, 'm1', 'title', [])
  })

  it('agentChat/agentPermission 桥接请求与事件', async () => {
    const api = await loadApi()

    await api.agentChat.send('c1', 'hello', [{ id: 'a1', name: 'a.txt' }])
    await api.agentChat.abort('c1')
    await api.agentChat.listSessions()
    await api.agentChat.deleteSession('c1')
    await api.agentChat.init({
      providerId: 'openai',
      model: 'm',
      baseUrl: 'https://api.example.com/v1',
      apiKeyStoreKey: 'openai-api-key'
    })
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.agentChat.send, {
      chatId: 'c1',
      text: 'hello',
      attachments: [{ id: 'a1', name: 'a.txt' }]
    })
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.agentChat.abort, { chatId: 'c1' })
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.agentChat.deleteSession, { chatId: 'c1' })

    const onEvent = vi.fn()
    const offEvent = api.agentChat.onEvent(onEvent)
    electron.listeners.get(IpcChannels.agentChat.event)?.({}, { type: 'done' })
    offEvent()
    expect(onEvent).toHaveBeenCalledWith({ type: 'done' })
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(
      IpcChannels.agentChat.event,
      expect.any(Function)
    )

    const onRequest = vi.fn()
    const offRequest = api.agentPermission.onRequest(onRequest)
    const req: PermissionRequest = {
      requestId: 'r1',
      chatId: 'c1',
      kind: 'shell',
      command: 'ls',
      program: 'ls'
    }
    electron.listeners.get(IpcChannels.agentPermission.request)?.({}, req)
    offRequest()
    await api.agentPermission.respond({ requestId: 'r1', choice: 'allow_once' })
    expect(onRequest).toHaveBeenCalledWith(req)
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.agentPermission.respond, {
      requestId: 'r1',
      choice: 'allow_once'
    })

  })

  it('组织文档打开桥接只传文档 ID', async () => {
    const api = await loadApi()
    await api.org.openDoc('doc-1')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.org.openDoc, 'doc-1')
  })
})
