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
    checkForUpdates: 'app:check-for-updates',
    /** 主进程 -> 渲染层:更新已下载,询问用户是否立即安装 */
    onUpdateDownloaded: 'app:update-downloaded',
    /** 渲染层 -> 主进程:用户确认后立即退出并安装已下载的更新 */
    installUpdate: 'app:install-update',
    /** 主进程 -> 渲染层:deep link 已解析,带跳转路径 + query */
    onDeepLink: 'app:deep-link'
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
    markSource: 'meeting:mark-source',
    /** 抽取可沉淀为组织知识的候选条目(企业版) */
    extractCandidates: 'meeting:extract-candidates'
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
    /** 切换目标会话:仅切会话,不发送任何文本(防幽灵回复)。 */
    switchSession: 'agent:chat:switch-session',
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
    /** 获取当前 gateway endpoint(baseUrl/apiPrefix/wsPath) */
    getEndpoint: 'echo:agent:get-endpoint',
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

  /** 会话管理 CRUD + 搜索/导入导出 */
  sessions: {
    create: 'sessions:create',
    list: 'sessions:list',
    get: 'sessions:get',
    update: 'sessions:update',
    delete: 'sessions:delete',
    search: 'sessions:search',
    export: 'sessions:export',
    import: 'sessions:import'
  },

  /** 用户配置管理 CRUD + 激活/导入导出 */
  profiles: {
    list: 'profiles:list',
    get: 'profiles:get',
    add: 'profiles:add',
    update: 'profiles:update',
    delete: 'profiles:delete',
    setActive: 'profiles:set-active',
    export: 'profiles:export',
    import: 'profiles:import'
  },

  /** 定时任务管理 CRUD + 执行日志 */
  schedules: {
    list: 'schedules:list',
    get: 'schedules:get',
    add: 'schedules:add',
    update: 'schedules:update',
    delete: 'schedules:delete',
    toggle: 'schedules:toggle',
    listLogs: 'schedules:list-logs',
    addLog: 'schedules:add-log'
  },

  /** 消息网关管理 CRUD + 连接测试/消息发送 */
  gateway: {
    listPlatforms: 'gateway:list-platforms',
    listConfigs: 'gateway:list-configs',
    addConfig: 'gateway:add-config',
    updateConfig: 'gateway:update-config',
    removeConfig: 'gateway:remove-config',
    getStatus: 'gateway:get-status',
    testConnection: 'gateway:test-connection',
    sendMessage: 'gateway:send-message',
    listMessages: 'gateway:list-messages'
  },

  /** 看板任务管理 CRUD + 移动/看板管理 */
  kanban: {
    listTasks: 'kanban:list-tasks',
    getTask: 'kanban:get-task',
    addTask: 'kanban:add-task',
    updateTask: 'kanban:update-task',
    deleteTask: 'kanban:delete-task',
    moveTask: 'kanban:move-task',
    listBoards: 'kanban:list-boards',
    getBoard: 'kanban:get-board',
    addBoard: 'kanban:add-board',
    updateBoard: 'kanban:update-board',
    deleteBoard: 'kanban:delete-board'
  },

  /** 灵魂配置管理 CRUD + 激活/模板管理 */
  soul: {
    list: 'soul:list',
    get: 'soul:get',
    add: 'soul:add',
    update: 'soul:update',
    delete: 'soul:delete',
    setActive: 'soul:set-active',
    addTemplate: 'soul:add-template',
    updateTemplate: 'soul:update-template',
    deleteTemplate: 'soul:delete-template'
  },

  /** 备份管理 CRUD */
  backup: {
    list: 'backup:list',
    create: 'backup:create',
    restore: 'backup:restore',
    delete: 'backup:delete'
  },

  /** 设置管理 */
  settings: {
    get: 'settings:get',
    update: 'settings:update'
  },

  /** 日志查询 */
  logs: {
    list: 'logs:list',
    add: 'logs:add',
    clear: 'logs:clear',
    getById: 'logs:get-by-id',
    delete: 'logs:delete',
    stats: 'logs:stats'
  },

  /**
   * 企业组织知识库(echo-agent-server)
   *
   * 全部经主进程转发:凭证存在 safeStorage 加密区,渲染层拿不到 token,
   * 即便页面被注入脚本也偷不走企业凭证。
   */
  org: {
    status: 'org:status',
    login: 'org:login',
    logout: 'org:logout',
    setServer: 'org:set-server',
    sync: 'org:sync',
    retrieve: 'org:retrieve',
    listDocs: 'org:list-docs',
    scopes: 'org:scopes',
    promote: 'org:promote',
    myPromotions: 'org:my-promotions',
    reportQa: 'org:report-qa',
    /** 主进程 -> 渲染层:登录态或可达性变化 */
    onStatusChanged: 'org:status-changed'
  },

  /**
   * 统一身份入口(2026-08 P1-2 修复)
   *
   * 渲染端一律通过 window.api.identity.* 访问;严禁直接调用 org.logout 或
   * 修改 safeStorage,以避免"退出登录只清一半"的串台 bug。
   */
  identity: {
    /** 获取当前活跃身份快照(org 优先,本地兜底) */
    current: 'identity:current',
    /** 当前是否登录了企业账号 */
    isOrgSignedIn: 'identity:is-org-signed-in',
    /** 统一登出:清空所有 provider 的 token / 缓存 / 用户数据 */
    signOut: 'identity:sign-out',
    /** 当前 safeStorage 是否可用 */
    isSecureStoreAvailable: 'identity:is-secure-store-available'
  }
} as const
