import { contextBridge, ipcRenderer } from 'electron'
import type { BridgeApi } from '@shared/types/api'
import type {
  AgentConfig,
  AgentProcessStatus,
  AgentScopeConfig,
  InstallProgressEvent,
  LogLevel,
  MediaPermissionType,
  NotifyOptions,
  OpenDialogOptions,
  SaveDialogOptions
} from '@shared/types'
import type { MeetingSummaryInput } from '@shared/types/meeting'
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
        ipcRenderer.invoke(IpcChannels.db.sessionUpdateTitle, chatId, title)
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
      ipcRenderer.invoke(IpcChannels.system.showSaveDialog, options)
  },

  log: {
    write: (level: LogLevel, message: string) =>
      ipcRenderer.send(IpcChannels.log.write, level, message)
  },

  agent: {
    getEnvInfo: () => ipcRenderer.invoke(IpcChannels.agent.getEnvInfo),
    start: () => ipcRenderer.invoke(IpcChannels.agent.start),
    stop: () => ipcRenderer.invoke(IpcChannels.agent.stop),
    restart: () => ipcRenderer.invoke(IpcChannels.agent.restart),
    getStatus: () => ipcRenderer.invoke(IpcChannels.agent.getStatus),
    getPort: () => ipcRenderer.invoke(IpcChannels.agent.getPort),
    initEnv: (pipIndex?: string) => ipcRenderer.invoke(IpcChannels.agent.initEnv, pipIndex),
    upgrade: (pipIndex?: string) => ipcRenderer.invoke(IpcChannels.agent.upgrade, pipIndex),
    resetEnv: (pipIndex?: string) => ipcRenderer.invoke(IpcChannels.agent.resetEnv, pipIndex),
    updateConfig: (config: AgentConfig) =>
      ipcRenderer.invoke(IpcChannels.agent.updateConfig, config),
    getLogs: () => ipcRenderer.invoke(IpcChannels.agent.getLogs),
    getScope: () => ipcRenderer.invoke(IpcChannels.agent.getScope),
    setScope: (config: AgentScopeConfig) =>
      ipcRenderer.invoke(IpcChannels.agent.setScope, config),
    httpProxy: (opts: {
      url: string
      method?: string
      headers?: Record<string, string>
      body?: string
      timeoutMs?: number
    }) =>
      ipcRenderer.invoke(IpcChannels.agent.httpProxy, opts) as Promise<{
        ok: boolean
        status: number
        body: string
      }>,
    onStatusChanged: (callback) => {
      const listener = (_e: Electron.IpcRendererEvent, status: unknown): void =>
        callback(status as AgentProcessStatus)
      ipcRenderer.on(IpcChannels.agent.onStatusChanged, listener)
      return () => ipcRenderer.removeListener(IpcChannels.agent.onStatusChanged, listener)
    },
    onInstallProgress: (callback) => {
      const listener = (_e: Electron.IpcRendererEvent, event: unknown): void =>
        callback(event as InstallProgressEvent)
      ipcRenderer.on(IpcChannels.agent.onInstallProgress, listener)
      return () => ipcRenderer.removeListener(IpcChannels.agent.onInstallProgress, listener)
    }
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
      ipcRenderer.invoke(IpcChannels.meeting.markSource, meetingId, source)
  },

  agentChat: {
    send: (chatId: string, text: string, attachments?: Array<{ id: string; name: string }>) =>
      ipcRenderer.invoke(IpcChannels.agentChat.send, { chatId, text, attachments }),
    abort: (chatId: string) => ipcRenderer.invoke(IpcChannels.agentChat.abort, { chatId }),
    listSessions: () => ipcRenderer.invoke(IpcChannels.agentChat.listSessions),
    deleteSession: (chatId: string) =>
      ipcRenderer.invoke(IpcChannels.agentChat.deleteSession, { chatId }),
    onEvent: (handler: (ev: Record<string, unknown>) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, ev: Record<string, unknown>): void =>
        handler(ev)
      ipcRenderer.on(IpcChannels.agentChat.event, listener)
      return () => ipcRenderer.removeListener(IpcChannels.agentChat.event, listener)
    }
  },

  platform: {
    isMac: process.platform === 'darwin',
    isWin: process.platform === 'win32',
    platform: process.platform
  }
}

contextBridge.exposeInMainWorld('api', api)
