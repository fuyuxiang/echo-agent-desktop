import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { IpcChannels } from '@shared/ipc-channels'

type Handler = (...args: unknown[]) => unknown

const electron = vi.hoisted(() => {
  const handlers = new Map<string, Handler>()
  const listeners = new Map<string, Handler>()
  const showNotification = vi.fn()
  const NotificationMock = Object.assign(
    vi.fn(function (this: { show: () => void }) {
      this.show = showNotification
    }),
    { isSupported: vi.fn(() => true) }
  )
  const win = {
    minimize: vi.fn(),
    isMaximized: vi.fn(() => false),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    close: vi.fn(),
    setAlwaysOnTop: vi.fn()
  }
  return {
    handlers,
    listeners,
    showNotification,
    win,
    app: {
      getVersion: vi.fn(() => '1.2.3'),
      relaunch: vi.fn(),
      exit: vi.fn(),
      quit: vi.fn(),
      getPath: vi.fn(() => path.join(os.tmpdir(), 'echo-user-data'))
    },
    ipcMain: {
      handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
      on: vi.fn((channel: string, handler: Handler) => listeners.set(channel, handler))
    },
    BrowserWindow: {
      fromWebContents: vi.fn(() => win)
    },
    clipboard: {
      readText: vi.fn(() => 'clip'),
      writeText: vi.fn()
    },
    dialog: {
      showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ['/tmp/a.txt'] })),
      showSaveDialog: vi.fn(async (): Promise<{ canceled: boolean; filePath?: string }> => ({
        canceled: false,
        filePath: '/tmp/out.txt'
      }))
    },
    Notification: NotificationMock,
    shell: {
      openExternal: vi.fn(),
      showItemInFolder: vi.fn()
    },
    net: {
      fetch: vi.fn(async () => new Response('proxy-ok', { status: 201 }))
    }
  }
})

const updater = vi.hoisted(() => ({
  checkForUpdates: vi.fn(async () => '2.0.0')
}))

const asr = vi.hoisted(() => ({
  createStream: vi.fn(() => 'stream-1'),
  feedAudio: vi.fn(),
  getResult: vi.fn(() => 'final text'),
  stopStream: vi.fn(() => 'stopped text'),
  createMeetingStream: vi.fn(() => 'meeting-stream-1'),
  feedMeetingAudio: vi.fn(),
  pollMeetingStream: vi.fn(() => ({
    confirmed: [{ startMs: 0, endMs: 1000, text: 'hello' }],
    partial: 'partial'
  })),
  stopMeetingStream: vi.fn(() => ({
    confirmed: [{ startMs: 1000, endMs: 2000, text: 'bye' }]
  }))
}))

const exampleDao = vi.hoisted(() => ({
  addExampleRecord: vi.fn((content: string) => ({ id: 1, content, createdAt: 10 })),
  clearExampleRecords: vi.fn(),
  listExampleRecords: vi.fn(() => [{ id: 1, content: 'a', createdAt: 10 }]),
  removeExampleRecord: vi.fn()
}))

const sessionDao = vi.hoisted(() => ({
  appendChatMessage: vi.fn((input: Record<string, unknown>) => ({ id: 1, ...input, createdAt: 10 })),
  deleteChatSession: vi.fn(),
  deleteLastAssistantMessage: vi.fn(),
  getChatMessages: vi.fn(() => [{ id: 1, chatId: 'c1', role: 'user', content: 'hi' }]),
  listChatSessions: vi.fn(() => [{ chatId: 'c1' }]),
  updateChatSessionTitle: vi.fn(),
  upsertChatSession: vi.fn()
}))

const meetingDao = vi.hoisted(() => {
  const meetings = new Map<string, Record<string, unknown>>()
  const segments = new Map<string, Array<Record<string, unknown>>>()
  const summaries = new Map<string, Record<string, unknown>>()
  return {
    reset: () => {
      meetings.clear()
      segments.clear()
      summaries.clear()
    },
    createMeeting: vi.fn((input: Record<string, unknown>) => {
      meetings.set(String(input.id), { ...input, status: 'recording', durationMs: 0 })
    }),
    listMeetings: vi.fn(() => Array.from(meetings.values())),
    getMeeting: vi.fn((id: string) => meetings.get(id) ?? null),
    appendSegment: vi.fn((input: Record<string, unknown>) => {
      const meetingId = String(input.meetingId)
      const list = segments.get(meetingId) ?? []
      list.push({ id: list.length + 1, ...input })
      segments.set(meetingId, list)
    }),
    getSegments: vi.fn((meetingId: string) => segments.get(meetingId) ?? []),
    finishMeeting: vi.fn((input: Record<string, unknown>) => {
      const id = String(input.id)
      meetings.set(id, { ...(meetings.get(id) ?? {}), ...input })
    }),
    updateMeetingStatus: vi.fn((id: string, status: string) => {
      meetings.set(id, { ...(meetings.get(id) ?? {}), id, status })
    }),
    updateMeetingAudioSource: vi.fn(),
    updateSegmentSpeaker: vi.fn(),
    upsertSummary: vi.fn((input: Record<string, unknown>) => summaries.set(String(input.meetingId), input)),
    getSummary: vi.fn((meetingId: string) => summaries.get(meetingId) ?? null),
    removeMeeting: vi.fn((meetingId: string) => meetings.delete(meetingId)),
    renameMeeting: vi.fn((meetingId: string, title: string) => {
      meetings.set(meetingId, { ...(meetings.get(meetingId) ?? {}), title })
    })
  }
})

const recorder = vi.hoisted(() => ({
  startRecording: vi.fn((meetingId: string, dir: string) => path.join(dir, `${meetingId}.wav`)),
  appendPcm: vi.fn(),
  finishRecording: vi.fn()
}))

const logger = vi.hoisted(() => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}))

const permission = vi.hoisted(() => ({
  checkMediaPermission: vi.fn(() => 'granted'),
  getLoginItemEnabled: vi.fn(() => true),
  requestMediaPermission: vi.fn(async () => 'granted'),
  setLoginItemEnabled: vi.fn()
}))

const store = vi.hoisted(() => ({
  secureDelete: vi.fn(),
  secureGet: vi.fn(() => 'secret'),
  secureSet: vi.fn(),
  storeClear: vi.fn(),
  storeDelete: vi.fn(),
  storeGet: vi.fn(() => 'value'),
  storeSet: vi.fn()
}))

const workspace = vi.hoisted(() => ({
  getScopeConfig: vi.fn(() => ({ scope: 'full', workspaceDir: '' })),
  setScopeConfig: vi.fn()
}))

const mainWindow = vi.hoisted(() => ({
  getMainWindow: vi.fn(() => null)
}))

vi.mock('electron', () => electron)
vi.mock('../../updater', () => updater)
vi.mock('../../asr', () => asr)
vi.mock('../../db/dao/example', () => exampleDao)
vi.mock('../../db/dao/session', () => sessionDao)
vi.mock('../../db/dao/meeting', () => meetingDao)
vi.mock('../../meeting/recorder', () => recorder)
vi.mock('../../logger', () => logger)
vi.mock('../../permission', () => permission)
vi.mock('../../store', () => store)
vi.mock('../../agent/workspace', () => workspace)
vi.mock('../../window', () => mainWindow)

function invoke<T = unknown>(channel: string, ...args: unknown[]): T {
  const handler = electron.handlers.get(channel)
  if (!handler) throw new Error(`missing handler: ${channel}`)
  return handler({ sender: {} }, ...args) as T
}

function emit(channel: string, ...args: unknown[]): unknown {
  const listener = electron.listeners.get(channel)
  if (!listener) throw new Error(`missing listener: ${channel}`)
  return listener({ sender: {} }, ...args)
}

beforeEach(() => {
  electron.handlers.clear()
  electron.listeners.clear()
  meetingDao.reset()
  vi.clearAllMocks()
  electron.Notification.isSupported.mockReturnValue(true)
  electron.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/tmp/a.txt'] })
  electron.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/out.txt' })
  electron.net.fetch.mockResolvedValue(new Response('proxy-ok', { status: 201 }))
  mainWindow.getMainWindow.mockReturnValue(null)
})

afterEach(() => {
  vi.doUnmock('../window')
  vi.doUnmock('../store')
  vi.resetModules()
})

describe('基础 IPC handlers', () => {
  it('app handlers 映射版本、重启、退出和检查更新', async () => {
    const { registerAppHandlers } = await import('../app')
    registerAppHandlers()

    expect(invoke(IpcChannels.app.getVersion)).toBe('1.2.3')
    expect(await invoke<Promise<string | null>>(IpcChannels.app.checkForUpdates)).toBe('2.0.0')

    emit(IpcChannels.app.relaunch)
    expect(electron.app.relaunch).toHaveBeenCalledTimes(1)
    expect(electron.app.exit).toHaveBeenCalledWith(0)

    emit(IpcChannels.app.quit)
    expect(electron.app.quit).toHaveBeenCalledTimes(1)
  })

  it('asr handlers 透传 stream 生命周期', async () => {
    const { registerAsrHandlers } = await import('../asr')
    registerAsrHandlers()

    const samples = new Float32Array([0.1, 0.2])
    expect(invoke(IpcChannels.asr.start)).toBe('stream-1')
    invoke(IpcChannels.asr.feed, 'stream-1', samples)
    expect(asr.feedAudio).toHaveBeenCalledWith('stream-1', samples)
    expect(invoke(IpcChannels.asr.getResult, 'stream-1')).toBe('final text')
    expect(invoke(IpcChannels.asr.stop, 'stream-1')).toBe('stopped text')
  })

  it('db handlers 透传 example 与 session DAO', async () => {
    const { registerDbHandlers } = await import('../db')
    registerDbHandlers()

    expect(invoke(IpcChannels.db.exampleList)).toEqual([{ id: 1, content: 'a', createdAt: 10 }])
    expect(invoke(IpcChannels.db.exampleAdd, 'new')).toMatchObject({ content: 'new' })
    invoke(IpcChannels.db.exampleRemove, 1)
    invoke(IpcChannels.db.exampleClear)
    expect(exampleDao.removeExampleRecord).toHaveBeenCalledWith(1)
    expect(exampleDao.clearExampleRecords).toHaveBeenCalledTimes(1)

    const input = { chatId: 'c1', title: 't', platform: 'desktop' }
    invoke(IpcChannels.db.sessionUpsert, input)
    expect(sessionDao.upsertChatSession).toHaveBeenCalledWith(input)
    expect(invoke(IpcChannels.db.sessionList)).toEqual([{ chatId: 'c1' }])
    expect(invoke(IpcChannels.db.sessionMessages, 'c1')).toHaveLength(1)
    expect(invoke(IpcChannels.db.sessionAppendMessage, { chatId: 'c1', role: 'user', content: 'hi' })).toMatchObject({
      chatId: 'c1',
      content: 'hi'
    })
    invoke(IpcChannels.db.sessionDeleteMessage, 'c1')
    invoke(IpcChannels.db.sessionUpdateTitle, 'c1', 'new title')
    invoke(IpcChannels.db.sessionDelete, 'c1')
    expect(sessionDao.deleteLastAssistantMessage).toHaveBeenCalledWith('c1')
    expect(sessionDao.updateChatSessionTitle).toHaveBeenCalledWith('c1', 'new title')
    expect(sessionDao.deleteChatSession).toHaveBeenCalledWith('c1')
  })

  it('log/store/permission handlers 使用主进程能力门面', async () => {
    const [{ registerLogHandlers }, { registerStoreHandlers }, { registerPermissionHandlers }] =
      await Promise.all([import('../log'), import('../store'), import('../permission')])
    registerLogHandlers()
    registerStoreHandlers()
    registerPermissionHandlers()

    emit(IpcChannels.log.write, 'info', 'hello')
    expect(logger.log.info).toHaveBeenCalledWith('[renderer] hello')

    expect(invoke(IpcChannels.store.get, 'k')).toBe('value')
    invoke(IpcChannels.store.set, 'k', 1)
    invoke(IpcChannels.store.delete, 'k')
    invoke(IpcChannels.store.clear)
    expect(store.storeSet).toHaveBeenCalledWith('k', 1)
    expect(store.storeDelete).toHaveBeenCalledWith('k')
    expect(store.storeClear).toHaveBeenCalledTimes(1)

    expect(invoke(IpcChannels.store.secureGet, 'token')).toBe('secret')
    invoke(IpcChannels.store.secureSet, 'token', 's')
    invoke(IpcChannels.store.secureDelete, 'token')
    expect(store.secureSet).toHaveBeenCalledWith('token', 's')
    expect(store.secureDelete).toHaveBeenCalledWith('token')

    expect(invoke(IpcChannels.permission.check, 'microphone')).toBe('granted')
    expect(await invoke<Promise<string>>(IpcChannels.permission.request, 'camera')).toBe('granted')
    expect(invoke(IpcChannels.permission.getLoginItem)).toBe(true)
    invoke(IpcChannels.permission.setLoginItem, false)
    expect(permission.setLoginItemEnabled).toHaveBeenCalledWith(false)
  })

  it('window handlers 操作 sender 所属 BrowserWindow', async () => {
    const { registerWindowHandlers } = await import('../window')
    registerWindowHandlers()

    emit(IpcChannels.window.minimize)
    expect(electron.win.minimize).toHaveBeenCalledTimes(1)

    electron.win.isMaximized.mockReturnValueOnce(false)
    emit(IpcChannels.window.toggleMaximize)
    expect(electron.win.maximize).toHaveBeenCalledTimes(1)

    electron.win.isMaximized.mockReturnValueOnce(true)
    emit(IpcChannels.window.toggleMaximize)
    expect(electron.win.unmaximize).toHaveBeenCalledTimes(1)

    expect(invoke(IpcChannels.window.isMaximized)).toBe(false)
    emit(IpcChannels.window.setAlwaysOnTop, true)
    emit(IpcChannels.window.close)
    expect(electron.win.setAlwaysOnTop).toHaveBeenCalledWith(true)
    expect(electron.win.close).toHaveBeenCalledTimes(1)
  })

  it('agent scope handler 拒绝非法 restricted，并接受有效目录', async () => {
    const { registerAgentIpcHandlers } = await import('../agent')
    registerAgentIpcHandlers()

    expect(invoke(IpcChannels.agent.getScope)).toEqual({ scope: 'full', workspaceDir: '' })
    expect(invoke(IpcChannels.agent.setScope, { scope: 'bad', workspaceDir: '' })).toMatchObject({
      success: false
    })
    expect(invoke(IpcChannels.agent.setScope, { scope: 'restricted', workspaceDir: 'relative' })).toMatchObject({
      success: false
    })

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-scope-'))
    expect(invoke(IpcChannels.agent.setScope, { scope: 'restricted', workspaceDir: dir })).toEqual({
      success: true
    })
    expect(workspace.setScopeConfig).toHaveBeenCalledWith({ scope: 'restricted', workspaceDir: dir })
  })
})

describe('system IPC handlers', () => {
  it('系统通知、剪贴板、shell 和文件对话框使用安全策略', async () => {
    const { registerSystemHandlers } = await import('../system')
    registerSystemHandlers()

    invoke(IpcChannels.system.notify, { title: 't', body: 'b', silent: true })
    expect(electron.showNotification).toHaveBeenCalledTimes(1)

    electron.Notification.isSupported.mockReturnValueOnce(false)
    invoke(IpcChannels.system.notify, { title: 't' })
    expect(logger.log.warn).toHaveBeenCalledWith('[system] 当前系统不支持通知')

    expect(invoke(IpcChannels.system.clipboardReadText)).toBe('clip')
    invoke(IpcChannels.system.clipboardWriteText, 'new clip')
    expect(electron.clipboard.writeText).toHaveBeenCalledWith('new clip')

    invoke(IpcChannels.system.openExternal, 'file:///etc/passwd')
    expect(electron.shell.openExternal).not.toHaveBeenCalled()
    invoke(IpcChannels.system.openExternal, 'https://example.com')
    expect(electron.shell.openExternal).toHaveBeenCalledWith('https://example.com')

    invoke(IpcChannels.system.showItemInFolder, '/tmp/a.txt')
    expect(electron.shell.showItemInFolder).toHaveBeenCalledWith('/tmp/a.txt')

    expect(await invoke<Promise<string[]>>(IpcChannels.system.showOpenDialog, {})).toEqual(['/tmp/a.txt'])
    electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: ['/tmp/nope'] })
    expect(await invoke<Promise<string[]>>(IpcChannels.system.showOpenDialog, {})).toEqual([])

    expect(await invoke<Promise<string | null>>(IpcChannels.system.showSaveDialog, {})).toBe('/tmp/out.txt')
    electron.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: true })
    expect(await invoke<Promise<string | null>>(IpcChannels.system.showSaveDialog, {})).toBeNull()
  })

  it('httpProxy 校验 URL 并通过 electron.net.fetch 返回响应', async () => {
    const { registerSystemHandlers } = await import('../system')
    registerSystemHandlers()

    await expect(invoke<Promise<unknown>>(IpcChannels.system.httpProxy, { url: 'not a url' })).resolves.toMatchObject({
      ok: false,
      status: 0
    })
    await expect(invoke<Promise<unknown>>(IpcChannels.system.httpProxy, { url: 'ftp://example.com' })).resolves.toMatchObject({
      ok: false,
      body: '不支持的协议: ftp:'
    })
    await expect(
      invoke<Promise<unknown>>(IpcChannels.system.httpProxy, { url: 'https://u:p@example.com' })
    ).resolves.toMatchObject({
      ok: false,
      body: 'URL 不允许包含嵌入凭据'
    })

    const result = await invoke<Promise<{ ok: boolean; status: number; body: string }>>(
      IpcChannels.system.httpProxy,
      {
        url: 'https://example.com/api',
        method: 'POST',
        headers: { 'X-Test': '1' },
        body: '{"a":1}',
        timeoutMs: 1000
      }
    )
    expect(result).toEqual({ ok: true, status: 201, body: 'proxy-ok' })
    expect(electron.net.fetch).toHaveBeenCalledWith(
      'https://example.com/api',
      expect.objectContaining({
        method: 'POST',
        headers: { 'X-Test': '1' },
        body: '{"a":1}'
      })
    )
  })
})

describe('meeting IPC handlers', () => {
  it('会议录音 start/feed/poll/stop 串接 ASR、录音和 DAO', async () => {
    const { registerMeetingHandlers } = await import('../meeting')
    registerMeetingHandlers()

    const started = await invoke<Promise<{ meetingId: string }>>(IpcChannels.meeting.start)
    expect(started.meetingId).toBeTruthy()
    expect(recorder.startRecording).toHaveBeenCalledWith(
      started.meetingId,
      path.join(os.tmpdir(), 'echo-user-data', 'meetings')
    )
    expect(asr.createMeetingStream).toHaveBeenCalledTimes(1)
    expect(meetingDao.createMeeting).toHaveBeenCalledWith(
      expect.objectContaining({ id: started.meetingId, audioSource: 'mic' })
    )

    const samples = new Float32Array([0.1, 0.2])
    invoke(IpcChannels.meeting.feed, started.meetingId, samples)
    expect(asr.feedMeetingAudio).toHaveBeenCalledWith('meeting-stream-1', samples)
    expect(recorder.appendPcm).toHaveBeenCalledWith(started.meetingId, samples)

    const polled = invoke<{ segments: unknown[]; partial: string }>(IpcChannels.meeting.poll, started.meetingId)
    expect(polled.partial).toBe('partial')
    expect(meetingDao.appendSegment).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: started.meetingId, idx: 0, text: 'hello' })
    )
    expect(polled.segments).toHaveLength(1)

    const stopped = invoke<{ meetingId: string; status: string }>(IpcChannels.meeting.stop, started.meetingId)
    expect(stopped).toEqual({ meetingId: started.meetingId, status: 'processing' })
    expect(asr.stopMeetingStream).toHaveBeenCalledWith('meeting-stream-1')
    expect(recorder.finishRecording).toHaveBeenCalledWith(started.meetingId)
    expect(meetingDao.finishMeeting).toHaveBeenCalledWith(
      expect.objectContaining({ id: started.meetingId, status: 'processing' })
    )

    expect(invoke(IpcChannels.meeting.poll, 'missing')).toEqual({ segments: [], partial: '' })
    expect(invoke(IpcChannels.meeting.stop, 'missing')).toEqual({ meetingId: 'missing', status: 'failed' })
  })

  it('会议列表、详情、纪要、删除、重命名和音源更新走 DAO', async () => {
    const { registerMeetingHandlers } = await import('../meeting')
    registerMeetingHandlers()

    const { meetingId } = await invoke<Promise<{ meetingId: string }>>(IpcChannels.meeting.start)
    invoke(IpcChannels.meeting.setSummary, meetingId, {
      summary: 's',
      keyPoints: ['k'],
      actionItems: ['a'],
      model: 'm'
    })
    expect(meetingDao.upsertSummary).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId, summary: 's' })
    )

    expect(invoke<{ meetings: unknown[] }>(IpcChannels.meeting.list).meetings).toHaveLength(1)
    expect(invoke<{ meeting: unknown; segments: unknown[]; summary: unknown }>(IpcChannels.meeting.get, meetingId)).toMatchObject({
      meeting: expect.objectContaining({ id: meetingId }),
      summary: expect.objectContaining({ summary: 's' })
    })

    invoke(IpcChannels.meeting.rename, meetingId, 'renamed')
    expect(meetingDao.renameMeeting).toHaveBeenCalledWith(meetingId, 'renamed')

    invoke(IpcChannels.meeting.markSource, meetingId, 'mic+system')
    expect(meetingDao.updateMeetingAudioSource).toHaveBeenCalledWith(meetingId, 'mic+system')

    await invoke<Promise<{ segments: unknown[] }>>(IpcChannels.meeting.diarize, meetingId)
    expect(meetingDao.updateMeetingStatus).toHaveBeenCalledWith(meetingId, 'done')

    invoke(IpcChannels.meeting.remove, meetingId)
    expect(meetingDao.removeMeeting).toHaveBeenCalledWith(meetingId)
  })
})

describe('IPC 注册中心', () => {
  it('registerAllIpcHandlers 按模块注册全部 handler 和审批桥', async () => {
    vi.resetModules()
    const calls: string[] = []
    const mockRegister = (label: string) => (): void => {
      calls.push(label)
    }
    vi.doMock('../window', () => ({ registerWindowHandlers: mockRegister('window') }))
    vi.doMock('../store', () => ({ registerStoreHandlers: mockRegister('store') }))
    vi.doMock('../db', () => ({ registerDbHandlers: mockRegister('db') }))
    vi.doMock('../permission', () => ({ registerPermissionHandlers: mockRegister('permission') }))
    vi.doMock('../app', () => ({ registerAppHandlers: mockRegister('app') }))
    vi.doMock('../system', () => ({ registerSystemHandlers: mockRegister('system') }))
    vi.doMock('../log', () => ({ registerLogHandlers: mockRegister('log') }))
    vi.doMock('../agent', () => ({ registerAgentIpcHandlers: mockRegister('agent') }))
    vi.doMock('../asr', () => ({ registerAsrHandlers: mockRegister('asr') }))
    vi.doMock('../meeting', () => ({ registerMeetingHandlers: mockRegister('meeting') }))
    vi.doMock('../agent-memory', () => ({ registerAgentMemoryIpc: mockRegister('agent-memory') }))
    vi.doMock('../agent-skill', () => ({ registerAgentSkillIpc: mockRegister('agent-skill') }))
    vi.doMock('../agent-chat', () => ({ registerAgentChatIpc: mockRegister('agent-chat') }))
    vi.doMock('../../agent/permission/approval-bridge', () => ({
      registerApprovalBridge: mockRegister('approval-bridge')
    }))

    const { registerAllIpcHandlers } = await import('../index')
    registerAllIpcHandlers()

    expect(calls).toEqual([
      'window',
      'store',
      'db',
      'permission',
      'app',
      'system',
      'log',
      'agent',
      'asr',
      'meeting',
      'agent-memory',
      'agent-skill',
      'agent-chat',
      'approval-bridge'
    ])
  })
})
