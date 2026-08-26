import type {
  AgentScopeConfig,
  ChatMessageRecord,
  ChatSessionRecord,
  LogLevel,
  MediaPermissionType,
  NotifyOptions,
  OpenDialogOptions,
  PermissionRequest,
  PermissionResponse,
  PermissionStatus,
  SaveDialogOptions
} from './index'
import type { MeetingDTO, SegmentDTO, SummaryDTO, MeetingSummaryInput } from './meeting'
import type { SessionConfig, SessionListResponse, SessionSearchRequest, SessionSearchResponse, SessionExportData, SessionImportData, SessionUpdateRequest } from '../session-types'
import type { ProfileConfig, ProfileListResponse, ProfileAddRequest, ProfileUpdateRequest, ProfileExportData, ProfileImportData } from '../profile-types'
import type { BackupConfig, BackupListResponse, BackupCreateRequest, BackupRestoreRequest, SettingsConfig, SettingsUpdateRequest, LogListResponse, LogQueryRequest } from '../settings-types'
import type { OrgStatus, OrgLoginResult, OrgModelConfig, OrgAdminUser, OrgAdminGroup, OrgDocContent, OrgMemory, SyncResult, RetrieveResult, OrgDocListResult, OrgScope, PromoteRequest, PromoteResult, MyPromotion, KnowledgeCandidate } from './org'

/**
 * echo-agent 进程状态(与 main 端 echo-agent/types.ts 字段一致;shared 不依赖 main)
 */
export interface EchoAgentStatus {
  phase: 'idle' | 'installing' | 'starting' | 'ready' | 'crashed' | 'updating' | 'error'
  port?: number
  message?: string
  detail?: string
}

/**
 * echo-agent gateway endpoint(与 main 端 echo-agent/types.ts 字段一致)
 */
export interface EchoAgentEndpoint {
  baseUrl: string
  apiPrefix: string
  wsPath: string
}

/**
 * 模型配置下发入参(渲染层本地手填,主进程落盘并下发给 echo-agent)
 */
export interface ModelConfigInput {
  baseUrl: string
  apiKey: string
  model: string
  source?: 'local' | 'enterprise' | 'ollama'
}

/**
 * 项目记忆本地镜像行(与 echo-agent 项目记忆双向同步的本地副本)
 */
/**
 * preload 通过 contextBridge 暴露给渲染层的 API 形状(window.api)
 *
 * - 渲染层一律通过 `utils/` 门面调用,不直接使用 window.api
 * - 新增能力时:先在此处定义类型,再实现主进程 handler 与 preload 桥接
 */
export interface BridgeApi {
  /** 窗口控制(自定义标题栏) */
  window: {
    /** 最小化窗口 */
    minimize: () => void
    /** 最大化/还原切换 */
    toggleMaximize: () => void
    /** 关闭窗口 */
    close: () => void
    /** 查询是否处于最大化 */
    isMaximized: () => Promise<boolean>
    /** 设置窗口置顶 */
    setAlwaysOnTop: (flag: boolean) => void
    /** 监听最大化状态变化,返回取消监听函数 */
    onMaximizeChanged: (callback: (maximized: boolean) => void) => () => void
  }

  /** KV 存储(electron-store) */
  store: {
    /** 读取配置项 */
    get: <T = unknown>(key: string) => Promise<T | undefined>
    /** 写入配置项 */
    set: (key: string, value: unknown) => Promise<void>
    /** 删除配置项 */
    delete: (key: string) => Promise<void>
    /** 清空全部配置 */
    clear: () => Promise<void>
    /** 读取加密配置(safeStorage 解密) */
    secureGet: (key: string) => Promise<string | undefined>
    /** 写入加密配置(safeStorage 加密) */
    secureSet: (key: string, value: string) => Promise<void>
    /** 删除加密配置 */
    secureDelete: (key: string) => Promise<void>
  }

  /** 本地数据库(better-sqlite3,DAO 形式暴露) */
  db: {
    session: {
      /** 会话列表(按最近活动倒序) */
      list: () => Promise<ChatSessionRecord[]>
      /** 确保会话存在(已存在不覆盖) */
      upsert: (input: { chatId: string; title?: string | null; platform?: string }) => Promise<void>
      /** 删除会话及其全部消息 */
      delete: (chatId: string) => Promise<void>
      /** 某会话全部消息(时间升序) */
      getMessages: (chatId: string) => Promise<ChatMessageRecord[]>
      /** 追加一条消息,返回完整记录 */
      appendMessage: (input: {
        chatId: string
        role: string
        content: string
        reasoning?: string | null
      }) => Promise<ChatMessageRecord>
      /** 删除会话最后一条 assistant 消息(重新生成时撤销上一轮回复) */
      deleteLastAssistantMessage: (chatId: string) => Promise<void>
      /** 更新会话标题 */
      updateTitle: (chatId: string, title: string) => Promise<void>
      /** 置顶/取消置顶会话 */
      setPinned: (chatId: string, pinned: boolean) => Promise<void>
    }
  }

  /** 系统权限 */
  permission: {
    /** 查询媒体权限状态 */
    check: (type: MediaPermissionType) => Promise<PermissionStatus>
    /** 申请媒体权限(mac 弹系统授权框;win 由系统设置控制,返回当前状态) */
    request: (type: MediaPermissionType) => Promise<PermissionStatus>
    /** 查询是否开机自启 */
    getLoginItem: () => Promise<boolean>
    /** 设置开机自启 */
    setLoginItem: (enable: boolean) => Promise<void>
  }

  /** 应用级能力 */
  app: {
    /** 获取应用版本号 */
    getVersion: () => Promise<string>
    /** 重启应用 */
    relaunch: () => void
    /** 退出应用 */
    quit: () => void
    /** 检查更新(更新服务器未配置时返回 null) */
    checkForUpdates: () => Promise<string | null>
    /** 监听更新下载完成事件,返回取消监听函数 */
    onUpdateDownloaded: (callback: (info: { version: string }) => void) => () => void
    /** 立即退出并安装已下载的更新;未启用更新或未打包时返回 false */
    installUpdate: () => Promise<boolean>
    /** 监听 deep link(echo-agent://...),渲染层收到后跳转到 payload.path */
    onDeepLink: (
      callback: (payload: { path: string; query: Record<string, string> }) => void
    ) => () => void
  }

  /** 系统能力 */
  system: {
    /** 发送系统通知 */
    notify: (options: NotifyOptions) => Promise<void>
    /** 读取剪贴板文本 */
    clipboardReadText: () => Promise<string>
    /** 写入剪贴板文本 */
    clipboardWriteText: (text: string) => Promise<void>
    /** 用系统默认浏览器打开链接 */
    openExternal: (url: string) => Promise<void>
    /** 在文件管理器中显示文件 */
    showItemInFolder: (fullPath: string) => Promise<void>
    /** 打开文件选择对话框,返回选中路径(取消返回空数组) */
    showOpenDialog: (options: OpenDialogOptions) => Promise<string[]>
    /** 打开文件保存对话框,返回保存路径(取消返回 null) */
    showSaveDialog: (options: SaveDialogOptions) => Promise<string | null>
    /** 仅访问回环地址上 Ollama 的 version/tags/pull。 */
    ollamaRequest: (opts: {
      baseUrl: string
      path: '/api/version' | '/api/tags' | '/api/pull'
      method?: 'GET' | 'POST'
      body?: unknown
    }) => Promise<{ ok: boolean; status: number; body: string }>
  }

  /** 日志(渲染层日志汇入主进程统一落盘) */
  log: {
    write: (level: LogLevel, message: string) => void
  }

  /** Agent scope 配置(P6 移除 Python 生命周期段后仅保留 scope) */
  agent: {
    getScope: () => Promise<AgentScopeConfig>
    setScope: (config: AgentScopeConfig) => Promise<{ success: boolean }>
  }

  /** 云端语音识别(2026-08 重构:本地 sherpa 改为云端切片上传,IPC 接口保持兼容) */
  asr: {
    start: () => Promise<string>
    feed: (streamId: string, samples: Float32Array) => Promise<void>
    getResult: (streamId: string) => Promise<string>
    stop: (streamId: string) => Promise<string>
  }

  /** 会议记录 */
  meeting: {
    start(): Promise<{ meetingId: string }>
    feed(meetingId: string, samples: Float32Array): Promise<void>
    poll(meetingId: string): Promise<{ segments: SegmentDTO[]; partial: string }>
    stop(meetingId: string): Promise<{ meetingId: string; status: string }>
    diarize(meetingId: string): Promise<{ segments: SegmentDTO[] }>
    setSummary(meetingId: string, data: MeetingSummaryInput): Promise<void>
    list(): Promise<{ meetings: MeetingDTO[] }>
    get(
      meetingId: string
    ): Promise<{ meeting: MeetingDTO | null; segments: SegmentDTO[]; summary: SummaryDTO | null }>
    remove(meetingId: string): Promise<void>
    rename(meetingId: string, title: string): Promise<void>
    markSource(meetingId: string, source: string): Promise<void>
    summarize(
      meetingId: string,
      title: string,
      segments: SegmentDTO[]
    ): Promise<{ summary: string; keyPoints: string[]; actionItems: string[] } | null>
    /**
     * 抽取可沉淀为组织知识的候选条目(企业版)。
     * 与 summarize 的区别:纪要是给人读的散文,候选是要进组织库的结构化
     * 条目 —— 带类型、依据与时间戳锚点。
     */
    extractCandidates(segments: SegmentDTO[]): Promise<KnowledgeCandidate[]>
  }

  /** 原生 agent 对话主链路(P5) */
  agentChat: {
    /**
     * 发送文本到当前会话。
     * - text 不允许为空(IPC 守门,空文本会抛 EmptyMessageError)
     * - requestId 由调用方生成(nanoid),流式响应按 requestId 路由,Stop 按 requestId 精准中止
     * - 切勿用 send 来"切换会话"——切换请走 switchSession
     */
    send(
      chatId: string,
      text: string,
      attachments?: Array<{ id: string; name: string }>,
      requestId?: string
    ): Promise<void>
    /**
     * 切换目标会话:仅切换,不发送任何文本。
     * 拆出来是为了防止"切会话"被静默变成"发空消息"(2026-08 审计 P0-3)。
     */
    switchSession(chatId: string): Promise<void>
    /** 中止请求。requestId 优先;省略则中止该会话当前活跃请求 */
    abort(chatId: string, requestId?: string): Promise<void>
    listSessions(): Promise<Array<{ chatId: string }>>
    deleteSession(chatId: string): Promise<{ success: boolean }>
    init(cfg: {
      providerId: string
      model: string
      baseUrl: string
      apiKeyStoreKey: string
    }): Promise<{ success: boolean }>
    /** 用一次轻量补全为会话生成简短标题;未就绪/失败返回空串 */
    generateTitle(firstUserMessage: string): Promise<string>
    /**
     * Skills 控制(2026-08 echo-agent 迁移)。
     * - 全部走 fire-and-await-ack:IPC 本身只 promise<void>,响应通过 onEvent 异步配对(request_id)
     * - requestId 由调用方生成(与 sendMessage 一致),错误和成功结果都按 request_id 路由回 renderer
     * - enable/disable 需要 skill 名称(name),list 不需要
     */
    sendSkillList(requestId: string): Promise<void>
    sendSkillEnable(name: string, requestId: string): Promise<void>
    sendSkillDisable(name: string, requestId: string): Promise<void>
    onEvent(handler: (ev: Record<string, unknown>) => void): () => void
  }

  /** Agent 工具权限审批(受限档逐次授权) */
  agentPermission: {
    onRequest(handler: (req: PermissionRequest) => void): () => void
    respond(res: PermissionResponse): Promise<{ ok: boolean }>
  }

  /** agent:skill IPC(P6 删除 agentSkill.*,走 agentChat.sendSkill* 异步配对) */

  /** 平台信息(同步常量,preload 注入) */
  platform: {
    /** 是否 macOS */
    isMac: boolean
    /** 是否 Windows */
    isWin: boolean
    /** process.platform 原始值 */
    platform: string
  }

  /** 备份管理 */
  backup: {
    /** 查询全部备份 */
    list: () => Promise<BackupListResponse>
    /** 创建备份 */
    create: (request: BackupCreateRequest) => Promise<BackupConfig>
    /** 恢复备份 */
    restore: (request: BackupRestoreRequest) => Promise<void>
    /** 删除备份 */
    delete: (id: string) => Promise<void>
  }

  /** 设置管理 */
  settings: {
    /** 获取设置 */
    get: () => Promise<SettingsConfig>
    /** 更新设置 */
    update: (request: SettingsUpdateRequest) => Promise<SettingsConfig>
  }

  /** 日志查询 */
  logs: {
    /** 查询日志 */
    list: (request?: LogQueryRequest) => Promise<LogListResponse>
    /** 清空日志 */
    clear: () => Promise<void>
  }

  /** echo-agent 进程生命周期 */
  echoAgent: {
    /** 读取当前进程状态 */
    getStatus: () => Promise<EchoAgentStatus>
    /** 读取当前安装的 echo-agent Python 包版本 */
    getVersion: () => Promise<string | null>
    /** 触发依赖更新 */
    update: () => Promise<void>
    /** 获取当前 gateway endpoint(baseUrl/apiPrefix/wsPath),未就绪时返回 null */
    getEndpoint: () => Promise<EchoAgentEndpoint | null>
    /** 受主进程路径白名单保护的 Agent 管理 API。 */
    managementRequest: <T = unknown>(request: {
      method: 'GET' | 'POST' | 'PUT' | 'DELETE'
      path: string
      body?: unknown
      file?: { name: string; mimeType: string; data: Uint8Array }
    }) => Promise<T>
    /** 监听状态变化,返回取消监听函数 */
    onStatusChanged: (cb: (s: EchoAgentStatus) => void) => () => void
  }

  /** echo-agent 模型配置下发 */
  echoConfig: {
    /** 下发模型配置(baseUrl/apiKey/model) */
    apply: (cfg: ModelConfigInput) => Promise<void>
  }

  /** 会话管理 CRUD + 搜索/导入导出 */
  sessions: {
    /** 创建新会话 */
    create: (request: { title: string; metadata?: Record<string, unknown> }) => Promise<SessionConfig>
    /** 查询全部会话(按日期分组) */
    list: () => Promise<SessionListResponse>
    /** 查询单个会话 */
    get: (id: string) => Promise<SessionConfig | null>
    /** 更新会话 */
    update: (request: SessionUpdateRequest) => Promise<SessionConfig>
    /** 删除会话及其关联消息 */
    delete: (id: string) => Promise<void>
    /** 搜索会话 */
    search: (request: SessionSearchRequest) => Promise<SessionSearchResponse>
    /** 导出会话及消息 */
    export: (id: string) => Promise<SessionExportData>
    /** 导入会话及消息 */
    import: (data: SessionImportData) => Promise<SessionConfig>
  }

  /** 用户配置管理 CRUD + 激活/导入导出 */
  profiles: {
    /** 查询全部配置 */
    list: () => Promise<ProfileListResponse>
    /** 查询单个配置 */
    get: (id: string) => Promise<ProfileConfig | null>
    /** 新增配置 */
    add: (request: ProfileAddRequest) => Promise<ProfileConfig>
    /** 更新配置 */
    update: (request: ProfileUpdateRequest) => Promise<ProfileConfig>
    /** 删除配置 */
    delete: (id: string) => Promise<void>
    /** 设置激活配置 */
    setActive: (id: string) => Promise<void>
    /** 导出配置 */
    export: (id: string) => Promise<ProfileExportData>
    /** 导入配置 */
    import: (data: ProfileImportData) => Promise<ProfileConfig>
  }

  /**
   * 企业组织知识库
   *
   * 全部经主进程转发。token 存在 safeStorage 加密区,渲染层拿不到也不该
   * 拿到 —— 页面若被注入脚本,偷不走企业凭证。
   */
  org: {
    /** 当前接入状态(是否配置、是否登录、缓存量、服务器可达性) */
    status: () => Promise<OrgStatus>
    /** 获取脱敏后的企业模型元数据；真实密钥只在服务端使用。 */
    modelConfig: () => Promise<OrgModelConfig>
    /** 配置服务器地址。切换地址会清掉旧凭证与缓存 */
    setServer: (url: string) => Promise<OrgStatus>
    login: (username: string, password: string) => Promise<OrgLoginResult>
    logout: () => Promise<void>
    /** 拉取增量知识到本地缓存(离线兜底) */
    sync: () => Promise<SyncResult>
    /** 检索组织知识。服务器不可达时自动降级到本地缓存 */
    retrieve: (
      query: string,
      opts?: { limit?: number; multi_hop?: boolean; scopes?: Array<'org' | 'team'> }
    ) => Promise<RetrieveResult>
    /** 列出当前账号可见的组织/团队记忆 */
    listMemories: (params?: { q?: string; kind?: string; scope?: string }) => Promise<OrgMemory[]>
    listDocs: (params: {
      scope_id?: string
      q?: string
      page?: number
      size?: number
    }) => Promise<OrgDocListResult>
    docContent: (id: string, page?: number) => Promise<OrgDocContent>
    docRaw: (id: string) => Promise<Uint8Array>
    /** 鉴权下载到权限受限的临时目录，并用系统默认应用打开。 */
    openDoc: (id: string) => Promise<void>
    /** 可写入的可见范围列表 */
    scopes: () => Promise<OrgScope[]>
    /** 提交候选知识。离线时入本地队列,联网后自动补提 */
    promote: (req: PromoteRequest) => Promise<PromoteResult>
    /** 我提交的(含本地未提交的) */
    myPromotions: () => Promise<MyPromotion[]>
    adminListUsers: () => Promise<OrgAdminUser[]>
    adminCreateUser: (input: {
      username: string
      password: string
      role: 'admin' | 'curator' | 'member'
      groupIds?: string[]
    }) => Promise<OrgAdminUser>
    adminUpdateUser: (
      id: string,
      patch: { role?: 'admin' | 'curator' | 'member'; status?: 'active' | 'disabled'; groupIds?: string[] }
    ) => Promise<OrgAdminUser>
    adminListGroups: () => Promise<OrgAdminGroup[]>
    adminCreateGroup: (name: string) => Promise<OrgAdminGroup>
    /** 上报问答质量,用于服务端质量看板 */
    reportQa: (body: {
      question: string
      answered: boolean
      cited_chunks?: string[]
      top_score?: number
      latency_ms?: number
      route?: 'fast' | 'agentic'
    }) => Promise<void>
    /** 监听接入状态变化,返回取消监听函数 */
    onStatusChanged: (callback: (status: OrgStatus) => void) => () => void
  }
}
