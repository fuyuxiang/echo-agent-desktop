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
    sessionUpdateTitle: 'db:session:update-title',
    sessionSetPinned: 'db:session:set-pinned'
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
    showSaveDialog: 'system:show-save-dialog',
    /** 通用 HTTP 代理(P6: 从 agent 段迁出,Python 移除后仍给 CORS 受限场景用) */
    httpProxy: 'system:http-proxy'
  },

  /** 渲染层日志汇入主进程 */
  log: {
    write: 'log:write'
  },

  /** Agent scope 配置(原生保留;Python 生命周期段已 P6 删除) */
  agent: {
    getScope: 'agent:get-scope',
    setScope: 'agent:set-scope'
  },

  /** Agent 工具权限审批(受限档逐次授权) */
  agentPermission: {
    /** 主进程 -> 渲染层:请求用户对一次高危动作授权 */
    request: 'agent:permission:request',
    /** 渲染层 -> 主进程:回填用户决定 */
    respond: 'agent:permission:respond'
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
    summarize: 'meeting:summarize',
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
  },

  /** 技能体系(P4) */
  agentSkill: {
    list: 'agent:skill:list',
    active: 'agent:skill:active',
    activate: 'agent:skill:activate',
    deactivate: 'agent:skill:deactivate'
  },

  /** 原生 agent 对话主链路(P5) */
  agentChat: {
    send: 'agent:chat:send',
    abort: 'agent:chat:abort',
    listSessions: 'agent:chat:list-sessions',
    deleteSession: 'agent:chat:delete-session',
    event: 'agent:chat:event',
    init: 'agent:chat:init',
    /** 用一次轻量补全为会话生成简短标题 */
    generateTitle: 'agent:chat:generate-title'
  },

  /** echo-agent 进程生命周期 */
  echoAgent: {
    getStatus: 'echo:agent:get-status',
    getVersion: 'echo:agent:get-version',
    update: 'echo:agent:update',
    /** 主进程 -> 渲染层:进程状态变化 */
    statusChanged: 'echo:agent:status-changed'
  },

  /** echo-agent 模型配置下发 */
  echoConfig: {
    apply: 'echo:config:apply'
  },

  /** 项目记忆本地镜像 CRUD */
  projectMemory: {
    listMirror: 'project-memory:list-mirror',
    upsertMirror: 'project-memory:upsert-mirror',
    deleteMirror: 'project-memory:delete-mirror'
  },

  /** 只读 echo-agent 认知记忆 */
  echoMemory: {
    list: 'echo-memory:list'
  },

  /** 模型配置 CRUD */
  models: {
    list: 'models:list',
    get: 'models:get',
    add: 'models:add',
    update: 'models:update',
    remove: 'models:remove',
    setActive: 'models:set-active'
  },

  /** 提供商配置 CRUD */
  providers: {
    list: 'providers:list',
    get: 'providers:get',
    add: 'providers:add',
    update: 'providers:update',
    remove: 'providers:remove',
    test: 'providers:test'
  },

  /** 会话管理 CRUD + 搜索/导入导出 */
  sessions: {
    list: 'sessions:list',
    get: 'sessions:get',
    update: 'sessions:update',
    delete: 'sessions:delete',
    search: 'sessions:search',
    export: 'sessions:export',
    import: 'sessions:import'
  }
} as const
