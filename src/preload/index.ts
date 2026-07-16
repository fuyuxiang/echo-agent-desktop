import { contextBridge, ipcRenderer } from 'electron'
import type { BridgeApi, EchoAgentStatus, ModelConfigInput, ProjectMemoryMirrorRow } from '@shared/types/api'
import type { ProviderAddRequest, ProviderUpdateRequest, ProviderTestRequest } from '@shared/provider-types'
import type {
  AgentScopeConfig,
  LogLevel,
  MediaPermissionType,
  NotifyOptions,
  OpenDialogOptions,
  PermissionRequest,
  PermissionResponse,
  SaveDialogOptions
} from '@shared/types'
import type { MeetingSummaryInput, SegmentDTO } from '@shared/types/meeting'
import type { SessionUpdateRequest, SessionSearchRequest, SessionImportData } from '@shared/session-types'
import type { ProfileAddRequest, ProfileUpdateRequest, ProfileImportData } from '@shared/profile-types'
import type { ScheduleAddRequest, ScheduleUpdateRequest, ScheduleExecutionLog } from '@shared/schedule-types'
import { IpcChannels } from '@shared/ipc-channels'

/**
 * preload:contextBridge 白名单桥接
 *
 * - 渲染层只能访问这里显式暴露的 API(window.api)
 * - 形状由 shared/types/api.ts 的 BridgeApi 约束,主进程/渲染层类型完全一致
 */
const api: BridgeApi = {
  window: {
    minimize: () => ipcRenderer.send(IpcChannels.window.minimize),
    toggleMaximize: () => ipcRenderer.send(IpcChannels.window.toggleMaximize),
    close: () => ipcRenderer.send(IpcChannels.window.close),
    isMaximized: () => ipcRenderer.invoke(IpcChannels.window.isMaximized),
    setAlwaysOnTop: (flag) => ipcRenderer.send(IpcChannels.window.setAlwaysOnTop, flag),
    onMaximizeChanged: (callback) => {
      const listener = (_e: Electron.IpcRendererEvent, maximized: boolean): void =>
        callback(maximized)
      ipcRenderer.on(IpcChannels.window.onMaximizeChanged, listener)
      return () => ipcRenderer.removeListener(IpcChannels.window.onMaximizeChanged, listener)
    }
  },

  store: {
    get: (key) => ipcRenderer.invoke(IpcChannels.store.get, key),
    set: (key, value) => ipcRenderer.invoke(IpcChannels.store.set, key, value),
    delete: (key) => ipcRenderer.invoke(IpcChannels.store.delete, key),
    clear: () => ipcRenderer.invoke(IpcChannels.store.clear),
    secureGet: (key) => ipcRenderer.invoke(IpcChannels.store.secureGet, key),
    secureSet: (key, value) => ipcRenderer.invoke(IpcChannels.store.secureSet, key, value),
    secureDelete: (key) => ipcRenderer.invoke(IpcChannels.store.secureDelete, key)
  },

  db: {
    example: {
      list: () => ipcRenderer.invoke(IpcChannels.db.exampleList),
      add: (content) => ipcRenderer.invoke(IpcChannels.db.exampleAdd, content),
      remove: (id) => ipcRenderer.invoke(IpcChannels.db.exampleRemove, id),
      clear: () => ipcRenderer.invoke(IpcChannels.db.exampleClear)
    },
    session: {
      list: () => ipcRenderer.invoke(IpcChannels.db.sessionList),
      upsert: (input) => ipcRenderer.invoke(IpcChannels.db.sessionUpsert, input),
      delete: (chatId) => ipcRenderer.invoke(IpcChannels.db.sessionDelete, chatId),
      getMessages: (chatId) => ipcRenderer.invoke(IpcChannels.db.sessionMessages, chatId),
      appendMessage: (input) => ipcRenderer.invoke(IpcChannels.db.sessionAppendMessage, input),
      deleteLastAssistantMessage: (chatId) =>
        ipcRenderer.invoke(IpcChannels.db.sessionDeleteMessage, chatId),
      updateTitle: (chatId, title) =>
        ipcRenderer.invoke(IpcChannels.db.sessionUpdateTitle, chatId, title),
      setPinned: (chatId, pinned) =>
        ipcRenderer.invoke(IpcChannels.db.sessionSetPinned, chatId, pinned)
    }
  },

  permission: {
    check: (type: MediaPermissionType) => ipcRenderer.invoke(IpcChannels.permission.check, type),
    request: (type: MediaPermissionType) =>
      ipcRenderer.invoke(IpcChannels.permission.request, type),
    getLoginItem: () => ipcRenderer.invoke(IpcChannels.permission.getLoginItem),
    setLoginItem: (enable) => ipcRenderer.invoke(IpcChannels.permission.setLoginItem, enable)
  },

  app: {
    getVersion: () => ipcRenderer.invoke(IpcChannels.app.getVersion),
    relaunch: () => ipcRenderer.send(IpcChannels.app.relaunch),
    quit: () => ipcRenderer.send(IpcChannels.app.quit),
    checkForUpdates: () => ipcRenderer.invoke(IpcChannels.app.checkForUpdates)
  },

  system: {
    notify: (options: NotifyOptions) => ipcRenderer.invoke(IpcChannels.system.notify, options),
    clipboardReadText: () => ipcRenderer.invoke(IpcChannels.system.clipboardReadText),
    clipboardWriteText: (text) => ipcRenderer.invoke(IpcChannels.system.clipboardWriteText, text),
    openExternal: (url) => ipcRenderer.invoke(IpcChannels.system.openExternal, url),
    showItemInFolder: (fullPath) =>
      ipcRenderer.invoke(IpcChannels.system.showItemInFolder, fullPath),
    showOpenDialog: (options: OpenDialogOptions) =>
      ipcRenderer.invoke(IpcChannels.system.showOpenDialog, options),
    showSaveDialog: (options: SaveDialogOptions) =>
      ipcRenderer.invoke(IpcChannels.system.showSaveDialog, options),
    httpProxy: (opts: {
      url: string
      method?: string
      headers?: Record<string, string>
      body?: string
      timeoutMs?: number
    }) =>
      ipcRenderer.invoke(IpcChannels.system.httpProxy, opts) as Promise<{
        ok: boolean
        status: number
        body: string
      }>
  },

  log: {
    write: (level: LogLevel, message: string) =>
      ipcRenderer.send(IpcChannels.log.write, level, message)
  },

  agent: {
    getScope: () => ipcRenderer.invoke(IpcChannels.agent.getScope),
    setScope: (config: AgentScopeConfig) =>
      ipcRenderer.invoke(IpcChannels.agent.setScope, config)
  },

  asr: {
    start: () => ipcRenderer.invoke(IpcChannels.asr.start),
    feed: (streamId: string, samples: Float32Array) =>
      ipcRenderer.invoke(IpcChannels.asr.feed, streamId, samples),
    getResult: (streamId: string) => ipcRenderer.invoke(IpcChannels.asr.getResult, streamId),
    stop: (streamId: string) => ipcRenderer.invoke(IpcChannels.asr.stop, streamId)
  },

  meeting: {
    start: () => ipcRenderer.invoke(IpcChannels.meeting.start),
    feed: (meetingId: string, samples: Float32Array) =>
      ipcRenderer.invoke(IpcChannels.meeting.feed, meetingId, samples),
    poll: (meetingId: string) => ipcRenderer.invoke(IpcChannels.meeting.poll, meetingId),
    stop: (meetingId: string) => ipcRenderer.invoke(IpcChannels.meeting.stop, meetingId),
    diarize: (meetingId: string) => ipcRenderer.invoke(IpcChannels.meeting.diarize, meetingId),
    setSummary: (meetingId: string, data: MeetingSummaryInput) =>
      ipcRenderer.invoke(IpcChannels.meeting.setSummary, meetingId, data),
    list: () => ipcRenderer.invoke(IpcChannels.meeting.list),
    get: (meetingId: string) => ipcRenderer.invoke(IpcChannels.meeting.get, meetingId),
    remove: (meetingId: string) => ipcRenderer.invoke(IpcChannels.meeting.remove, meetingId),
    rename: (meetingId: string, title: string) =>
      ipcRenderer.invoke(IpcChannels.meeting.rename, meetingId, title),
    markSource: (meetingId: string, source: string) =>
      ipcRenderer.invoke(IpcChannels.meeting.markSource, meetingId, source),
    summarize: (meetingId: string, title: string, segments: SegmentDTO[]) =>
      ipcRenderer.invoke(IpcChannels.meeting.summarize, meetingId, title, segments)
  },

  agentChat: {
    send: (chatId: string, text: string, attachments?: Array<{ id: string; name: string }>) =>
      ipcRenderer.invoke(IpcChannels.agentChat.send, { chatId, text, attachments }),
    abort: (chatId: string) => ipcRenderer.invoke(IpcChannels.agentChat.abort, { chatId }),
    listSessions: () => ipcRenderer.invoke(IpcChannels.agentChat.listSessions),
    deleteSession: (chatId: string) =>
      ipcRenderer.invoke(IpcChannels.agentChat.deleteSession, { chatId }),
    init: (cfg: {
      providerId: string
      model: string
      baseUrl: string
      apiKeyStoreKey: string
    }) => ipcRenderer.invoke(IpcChannels.agentChat.init, cfg),
    generateTitle: (firstUserMessage: string): Promise<string> =>
      ipcRenderer.invoke(IpcChannels.agentChat.generateTitle, { firstUserMessage }),
    onEvent: (handler: (ev: Record<string, unknown>) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, ev: Record<string, unknown>): void =>
        handler(ev)
      ipcRenderer.on(IpcChannels.agentChat.event, listener)
      return () => ipcRenderer.removeListener(IpcChannels.agentChat.event, listener)
    }
  },

  echoAgent: {
    getStatus: () => ipcRenderer.invoke(IpcChannels.echoAgent.getStatus),
    getVersion: () => ipcRenderer.invoke(IpcChannels.echoAgent.getVersion),
    update: () => ipcRenderer.invoke(IpcChannels.echoAgent.update),
    onStatusChanged: (cb: (s: EchoAgentStatus) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, s: EchoAgentStatus): void => cb(s)
      ipcRenderer.on(IpcChannels.echoAgent.statusChanged, listener)
      return () => ipcRenderer.removeListener(IpcChannels.echoAgent.statusChanged, listener)
    }
  },

  echoConfig: {
    apply: (cfg: ModelConfigInput) => ipcRenderer.invoke(IpcChannels.echoConfig.apply, cfg)
  },

  projectMemory: {
    listMirror: () => ipcRenderer.invoke(IpcChannels.projectMemory.listMirror),
    upsertMirror: (row: ProjectMemoryMirrorRow) =>
      ipcRenderer.invoke(IpcChannels.projectMemory.upsertMirror, row),
    deleteMirror: (serverId: string) =>
      ipcRenderer.invoke(IpcChannels.projectMemory.deleteMirror, serverId)
  },

  echoMemory: {
    list: (limit?: number) => ipcRenderer.invoke(IpcChannels.echoMemory.list, limit)
  },

  agentPermission: {
    onRequest: (handler: (req: PermissionRequest) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, req: PermissionRequest): void => handler(req)
      ipcRenderer.on(IpcChannels.agentPermission.request, listener)
      return () => ipcRenderer.removeListener(IpcChannels.agentPermission.request, listener)
    },
    respond: (res: PermissionResponse) =>
      ipcRenderer.invoke(IpcChannels.agentPermission.respond, res)
  },

  agentMemory: {
    list: (opts: { limit: number; offset: number }) =>
      ipcRenderer.invoke(IpcChannels.agentMemory.list, opts),
    search: (opts: { query: string; topK?: number }) =>
      ipcRenderer.invoke(IpcChannels.agentMemory.search, opts),
    get: (id: number) => ipcRenderer.invoke(IpcChannels.agentMemory.get, { id }),
    update: (id: number, patch: Record<string, unknown>) =>
      ipcRenderer.invoke(IpcChannels.agentMemory.update, { id, patch }),
    delete: (id: number) => ipcRenderer.invoke(IpcChannels.agentMemory.delete, { id }),
    stats: () => ipcRenderer.invoke(IpcChannels.agentMemory.stats)
  },

  agentSkill: {
    list: () => ipcRenderer.invoke(IpcChannels.agentSkill.list),
    active: (chatId: string) =>
      ipcRenderer.invoke(IpcChannels.agentSkill.active, { chatId }),
    activate: (chatId: string, skillId: string) =>
      ipcRenderer.invoke(IpcChannels.agentSkill.activate, { chatId, skillId }),
    deactivate: (chatId: string, skillId: string) =>
      ipcRenderer.invoke(IpcChannels.agentSkill.deactivate, { chatId, skillId })
  },

  models: {
    list: () => ipcRenderer.invoke(IpcChannels.models.list),
    get: (id: string) => ipcRenderer.invoke(IpcChannels.models.get, id),
    add: (request) => ipcRenderer.invoke(IpcChannels.models.add, request),
    update: (request) => ipcRenderer.invoke(IpcChannels.models.update, request),
    remove: (id: string) => ipcRenderer.invoke(IpcChannels.models.remove, id),
    setActive: (id: string) => ipcRenderer.invoke(IpcChannels.models.setActive, id)
  },

  providers: {
    list: () => ipcRenderer.invoke(IpcChannels.providers.list),
    get: (id: string) => ipcRenderer.invoke(IpcChannels.providers.get, id),
    add: (request: ProviderAddRequest) => ipcRenderer.invoke(IpcChannels.providers.add, request),
    update: (request: ProviderUpdateRequest) => ipcRenderer.invoke(IpcChannels.providers.update, request),
    remove: (id: string) => ipcRenderer.invoke(IpcChannels.providers.remove, id),
    test: (request: ProviderTestRequest) => ipcRenderer.invoke(IpcChannels.providers.test, request)
  },

  sessions: {
    create: (request: { title: string; metadata?: Record<string, unknown> }) =>
      ipcRenderer.invoke(IpcChannels.sessions.create, request),
    list: () => ipcRenderer.invoke(IpcChannels.sessions.list),
    get: (id: string) => ipcRenderer.invoke(IpcChannels.sessions.get, id),
    update: (request: SessionUpdateRequest) => ipcRenderer.invoke(IpcChannels.sessions.update, request),
    delete: (id: string) => ipcRenderer.invoke(IpcChannels.sessions.delete, id),
    search: (request: SessionSearchRequest) => ipcRenderer.invoke(IpcChannels.sessions.search, request),
    export: (id: string) => ipcRenderer.invoke(IpcChannels.sessions.export, id),
    import: (data: SessionImportData) => ipcRenderer.invoke(IpcChannels.sessions.import, data)
  },

  profiles: {
    list: () => ipcRenderer.invoke(IpcChannels.profiles.list),
    get: (id: string) => ipcRenderer.invoke(IpcChannels.profiles.get, id),
    add: (request: ProfileAddRequest) => ipcRenderer.invoke(IpcChannels.profiles.add, request),
    update: (request: ProfileUpdateRequest) => ipcRenderer.invoke(IpcChannels.profiles.update, request),
    delete: (id: string) => ipcRenderer.invoke(IpcChannels.profiles.delete, id),
    setActive: (id: string) => ipcRenderer.invoke(IpcChannels.profiles.setActive, id),
    export: (id: string) => ipcRenderer.invoke(IpcChannels.profiles.export, id),
    import: (data: ProfileImportData) => ipcRenderer.invoke(IpcChannels.profiles.import, data)
  },

  schedules: {
    list: () => ipcRenderer.invoke(IpcChannels.schedules.list),
    get: (id: string) => ipcRenderer.invoke(IpcChannels.schedules.get, id),
    add: (request: ScheduleAddRequest) => ipcRenderer.invoke(IpcChannels.schedules.add, request),
    update: (request: ScheduleUpdateRequest) => ipcRenderer.invoke(IpcChannels.schedules.update, request),
    delete: (id: string) => ipcRenderer.invoke(IpcChannels.schedules.delete, id),
    toggle: (id: string) => ipcRenderer.invoke(IpcChannels.schedules.toggle, id),
    listLogs: (scheduleId: string) => ipcRenderer.invoke(IpcChannels.schedules.listLogs, scheduleId),
    addLog: (log: Omit<ScheduleExecutionLog, 'id'>) => ipcRenderer.invoke(IpcChannels.schedules.addLog, log)
  },

  backup: {
    list: () => ipcRenderer.invoke(IpcChannels.backup.list),
    create: (request: { name: string; description?: string }) =>
      ipcRenderer.invoke(IpcChannels.backup.create, request),
    restore: (request: { id: string }) =>
      ipcRenderer.invoke(IpcChannels.backup.restore, request),
    delete: (id: string) => ipcRenderer.invoke(IpcChannels.backup.delete, id)
  },

  settings: {
    get: () => ipcRenderer.invoke(IpcChannels.settings.get),
    update: (request: { theme?: string; language?: string; network?: { proxy?: string; timeout: number; retryCount?: number }; metadata?: Record<string, unknown> }) =>
      ipcRenderer.invoke(IpcChannels.settings.update, request)
  },

  logs: {
    list: (request?: { level?: string; startTime?: string; endTime?: string; limit?: number; offset?: number }) =>
      ipcRenderer.invoke(IpcChannels.logs.list, request),
    clear: () => ipcRenderer.invoke(IpcChannels.logs.clear)
  },

  gateway: {
    listPlatforms: () => ipcRenderer.invoke(IpcChannels.gateway.listPlatforms),
    listConfigs: () => ipcRenderer.invoke(IpcChannels.gateway.listConfigs),
    addConfig: (request) => ipcRenderer.invoke(IpcChannels.gateway.addConfig, request),
    updateConfig: (request) => ipcRenderer.invoke(IpcChannels.gateway.updateConfig, request),
    removeConfig: (id) => ipcRenderer.invoke(IpcChannels.gateway.removeConfig, id),
    getStatus: (platformId) => ipcRenderer.invoke(IpcChannels.gateway.getStatus, platformId),
    testConnection: (request) => ipcRenderer.invoke(IpcChannels.gateway.testConnection, request)
  },

  kanban: {
    listTasks: () => ipcRenderer.invoke(IpcChannels.kanban.listTasks),
    getTask: (id) => ipcRenderer.invoke(IpcChannels.kanban.getTask, id),
    addTask: (request) => ipcRenderer.invoke(IpcChannels.kanban.addTask, request),
    updateTask: (request) => ipcRenderer.invoke(IpcChannels.kanban.updateTask, request),
    deleteTask: (id) => ipcRenderer.invoke(IpcChannels.kanban.deleteTask, id),
    moveTask: (request) => ipcRenderer.invoke(IpcChannels.kanban.moveTask, request),
    listBoards: () => ipcRenderer.invoke(IpcChannels.kanban.listBoards),
    getBoard: (id) => ipcRenderer.invoke(IpcChannels.kanban.getBoard, id),
    addBoard: (request) => ipcRenderer.invoke(IpcChannels.kanban.addBoard, request),
    updateBoard: (request) => ipcRenderer.invoke(IpcChannels.kanban.updateBoard, request),
    deleteBoard: (id) => ipcRenderer.invoke(IpcChannels.kanban.deleteBoard, id)
  },

  soul: {
    list: () => ipcRenderer.invoke(IpcChannels.soul.list),
    get: (id) => ipcRenderer.invoke(IpcChannels.soul.get, id),
    add: (request) => ipcRenderer.invoke(IpcChannels.soul.add, request),
    update: (request) => ipcRenderer.invoke(IpcChannels.soul.update, request),
    delete: (id) => ipcRenderer.invoke(IpcChannels.soul.delete, id),
    setActive: (id) => ipcRenderer.invoke(IpcChannels.soul.setActive, id),
    addTemplate: (request) => ipcRenderer.invoke(IpcChannels.soul.addTemplate, request),
    updateTemplate: (request) => ipcRenderer.invoke(IpcChannels.soul.updateTemplate, request),
    deleteTemplate: (id) => ipcRenderer.invoke(IpcChannels.soul.deleteTemplate, id)
  },

  platform: {
    isMac: process.platform === 'darwin',
    isWin: process.platform === 'win32',
    platform: process.platform
  }
}

contextBridge.exposeInMainWorld('api', api)
