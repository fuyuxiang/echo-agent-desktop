/**
 * IPC channel 常量(全项目唯一来源)
 *
 * 约定:
 * - 命名格式为 `模块:动作`
 * - 主进程 handlers 与 preload 桥接必须引用此处常量,禁止手写字符串
 */
export const IpcChannels = {
  /** 窗口控制(自定义标题栏用) */
  window: {
    minimize: 'window:minimize',
    toggleMaximize: 'window:toggle-maximize',
    close: 'window:close',
    isMaximized: 'window:is-maximized',
    setAlwaysOnTop: 'window:set-always-on-top',
    /** 主进程 -> 渲染层:最大化状态变化 */
    onMaximizeChanged: 'window:maximize-changed'
  },

  /** KV 存储(electron-store) */
  store: {
    get: 'store:get',
    set: 'store:set',
    delete: 'store:delete',
    clear: 'store:clear',
    /** safeStorage 加密存储(token 等敏感数据) */
    secureGet: 'store:secure-get',
    secureSet: 'store:secure-set',
    secureDelete: 'store:secure-delete'
  },

  /** 本地数据库(better-sqlite3) */
  db: {
    exampleList: 'db:example:list',
    exampleAdd: 'db:example:add',
    exampleRemove: 'db:example:remove',
    exampleClear: 'db:example:clear',
    sessionList: 'db:session:list',
    sessionUpsert: 'db:session:upsert',
    sessionDelete: 'db:session:delete',
    sessionMessages: 'db:session:messages',
    sessionAppendMessage: 'db:session:append-message',
    sessionDeleteMessage: 'db:session:delete-message',
    sessionUpdateTitle: 'db:session:update-title'
  },

  /** 系统权限 */
  permission: {
    check: 'permission:check',
    request: 'permission:request',
    getLoginItem: 'permission:get-login-item',
    setLoginItem: 'permission:set-login-item'
  },

  /** 应用级能力 */
  app: {
    getVersion: 'app:get-version',
    relaunch: 'app:relaunch',
    quit: 'app:quit',
    checkForUpdates: 'app:check-for-updates'
  },

  /** 系统能力(通知/剪贴板/shell/对话框) */
  system: {
    notify: 'system:notify',
    clipboardReadText: 'system:clipboard-read-text',
    clipboardWriteText: 'system:clipboard-write-text',
    openExternal: 'system:open-external',
    showItemInFolder: 'system:show-item-in-folder',
    showOpenDialog: 'system:show-open-dialog',
    showSaveDialog: 'system:show-save-dialog'
  },

  /** 渲染层日志汇入主进程 */
  log: {
    write: 'log:write'
  },

  /** Agent 进程管理 */
  agent: {
    getEnvInfo: 'agent:get-env-info',
    start: 'agent:start',
    stop: 'agent:stop',
    restart: 'agent:restart',
    getStatus: 'agent:get-status',
    getPort: 'agent:get-port',
    initEnv: 'agent:init-env',
    upgrade: 'agent:upgrade',
    resetEnv: 'agent:reset-env',
    updateConfig: 'agent:update-config',
    getLogs: 'agent:get-logs',
    getScope: 'agent:get-scope',
    setScope: 'agent:set-scope',
    onStatusChanged: 'agent:status-changed',
    onInstallProgress: 'agent:install-progress',
    /** 通过主进程代理 HTTP 请求（绕过渲染进程 CORS 限制） */
    httpProxy: 'agent:http-proxy'
  },

  /** 本地语音识别(sherpa-onnx) */
  asr: {
    start: 'asr:start',
    feed: 'asr:feed',
    getResult: 'asr:get-result',
    stop: 'asr:stop'
  },

  /** 会议记录 */
  meeting: {
    start: 'meeting:start',
    feed: 'meeting:feed',
    poll: 'meeting:poll',
    stop: 'meeting:stop',
    diarize: 'meeting:diarize',
    setSummary: 'meeting:set-summary',
    list: 'meeting:list',
    get: 'meeting:get',
    remove: 'meeting:remove',
    rename: 'meeting:rename',
    markSource: 'meeting:mark-source'
  },

  /** 认知记忆系统(P3) */
  agentMemory: {
    list: 'agent:memory:list',
    search: 'agent:memory:search',
    get: 'agent:memory:get',
    update: 'agent:memory:update',
    delete: 'agent:memory:delete',
    stats: 'agent:memory:stats'
  }
} as const
