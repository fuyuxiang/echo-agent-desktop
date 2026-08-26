import { contextBridge, ipcRenderer } from 'electron'
import type { BridgeApi, EchoAgentEndpoint, EchoAgentStatus, ModelConfigInput } from '@shared/types/api'
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
import type { OrgStatus } from '@shared/types/org'
import type { SessionUpdateRequest, SessionSearchRequest, SessionImportData } from '@shared/session-types'
import type { ProfileAddRequest, ProfileUpdateRequest, ProfileImportData } from '@shared/profile-types'
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
    checkForUpdates: () => ipcRenderer.invoke(IpcChannels.app.checkForUpdates),
    onUpdateDownloaded: (callback) => {
      const listener = (_e: Electron.IpcRendererEvent, info: { version: string }): void =>
        callback(info)
      ipcRenderer.on(IpcChannels.app.onUpdateDownloaded, listener)
      return () => ipcRenderer.removeListener(IpcChannels.app.onUpdateDownloaded, listener)
    },
    installUpdate: () => ipcRenderer.invoke(IpcChannels.app.installUpdate) as Promise<boolean>,
    onDeepLink: (callback) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        payload: { path: string; query: Record<string, string> }
      ): void => callback(payload)
      ipcRenderer.on(IpcChannels.app.onDeepLink, listener)
      return () => ipcRenderer.removeListener(IpcChannels.app.onDeepLink, listener)
    }
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
    ollamaRequest: (opts) => ipcRenderer.invoke(IpcChannels.system.ollamaRequest, opts)
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
      ipcRenderer.invoke(IpcChannels.meeting.summarize, meetingId, title, segments),
    extractCandidates: (segments: SegmentDTO[]) =>
      ipcRenderer.invoke(IpcChannels.meeting.extractCandidates, segments)
  },

  agentChat: {
    send: (
      chatId: string,
      text: string,
      attachments?: Array<{ id: string; name: string }>,
      requestId?: string
    ) => ipcRenderer.invoke(IpcChannels.agentChat.send, { chatId, text, attachments, requestId }),
    switchSession: (chatId: string) =>
      ipcRenderer.invoke(IpcChannels.agentChat.switchSession, { chatId }),
    abort: (chatId: string, requestId?: string) =>
      ipcRenderer.invoke(IpcChannels.agentChat.abort, { chatId, requestId }),
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
    // Skills 桥接:fire-and-await-ack,响应走 onEvent + request_id 配对
    sendSkillList: (requestId: string): Promise<void> =>
      ipcRenderer.invoke(IpcChannels.agentChat.sendSkillList, { requestId }) as Promise<void>,
    sendSkillEnable: (name: string, requestId: string): Promise<void> =>
      ipcRenderer.invoke(IpcChannels.agentChat.sendSkillEnable, { name, requestId }) as Promise<void>,
    sendSkillDisable: (name: string, requestId: string): Promise<void> =>
      ipcRenderer.invoke(IpcChannels.agentChat.sendSkillDisable, { name, requestId }) as Promise<void>,
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
    getEndpoint: () =>
      ipcRenderer.invoke(IpcChannels.echoAgent.getEndpoint) as Promise<EchoAgentEndpoint | null>,
    managementRequest: (request) =>
      ipcRenderer.invoke(IpcChannels.echoAgent.managementRequest, request),
    onStatusChanged: (cb: (s: EchoAgentStatus) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, s: EchoAgentStatus): void => cb(s)
      ipcRenderer.on(IpcChannels.echoAgent.statusChanged, listener)
      return () => ipcRenderer.removeListener(IpcChannels.echoAgent.statusChanged, listener)
    }
  },

  echoConfig: {
    apply: (cfg: ModelConfigInput) => ipcRenderer.invoke(IpcChannels.echoConfig.apply, cfg)
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

  org: {
    status: () => ipcRenderer.invoke(IpcChannels.org.status),
    modelConfig: () => ipcRenderer.invoke(IpcChannels.org.modelConfig),
    setServer: (url) => ipcRenderer.invoke(IpcChannels.org.setServer, url),
    login: (username, password) =>
      ipcRenderer.invoke(IpcChannels.org.login, username, password),
    logout: () => ipcRenderer.invoke(IpcChannels.org.logout),
    sync: () => ipcRenderer.invoke(IpcChannels.org.sync),
    retrieve: (query, opts) => ipcRenderer.invoke(IpcChannels.org.retrieve, query, opts),
    listMemories: (params) => ipcRenderer.invoke(IpcChannels.org.listMemories, params),
    listDocs: (params) => ipcRenderer.invoke(IpcChannels.org.listDocs, params),
    docContent: (id, page) => ipcRenderer.invoke(IpcChannels.org.docContent, id, page),
    docRaw: (id) => ipcRenderer.invoke(IpcChannels.org.docRaw, id),
    openDoc: (id) => ipcRenderer.invoke(IpcChannels.org.openDoc, id),
    scopes: () => ipcRenderer.invoke(IpcChannels.org.scopes),
    promote: (req) => ipcRenderer.invoke(IpcChannels.org.promote, req),
    myPromotions: () => ipcRenderer.invoke(IpcChannels.org.myPromotions),
    adminListUsers: () => ipcRenderer.invoke(IpcChannels.org.adminListUsers),
    adminCreateUser: (input) => ipcRenderer.invoke(IpcChannels.org.adminCreateUser, input),
    adminUpdateUser: (id, patch) =>
      ipcRenderer.invoke(IpcChannels.org.adminUpdateUser, id, patch),
    adminListGroups: () => ipcRenderer.invoke(IpcChannels.org.adminListGroups),
    adminCreateGroup: (name) => ipcRenderer.invoke(IpcChannels.org.adminCreateGroup, name),
    reportQa: (body) => ipcRenderer.invoke(IpcChannels.org.reportQa, body),
    onStatusChanged: (callback) => {
      const listener = (_e: Electron.IpcRendererEvent, status: OrgStatus): void =>
        callback(status)
      ipcRenderer.on(IpcChannels.org.onStatusChanged, listener)
      return () => ipcRenderer.removeListener(IpcChannels.org.onStatusChanged, listener)
    }
  },

  platform: {
    isMac: process.platform === 'darwin',
    isWin: process.platform === 'win32',
    platform: process.platform
  }
}

contextBridge.exposeInMainWorld('api', api)
