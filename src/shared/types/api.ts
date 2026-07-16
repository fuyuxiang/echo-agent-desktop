import type {
  AgentScopeConfig,
  ChatMessageRecord,
  ChatSessionRecord,
  ExampleRecord,
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
import type { ModelConfig, ModelListResponse, ModelAddRequest, ModelUpdateRequest } from '../model-types'
import type { ProviderConfig, ProviderListResponse, ProviderAddRequest, ProviderUpdateRequest, ProviderTestResult, ProviderTestRequest } from '../provider-types'
import type { SessionConfig, SessionListResponse, SessionSearchRequest, SessionSearchResponse, SessionExportData, SessionImportData, SessionUpdateRequest } from '../session-types'
import type { ProfileConfig, ProfileListResponse, ProfileAddRequest, ProfileUpdateRequest, ProfileExportData, ProfileImportData } from '../profile-types'
import type { ScheduleConfig, ScheduleListResponse, ScheduleAddRequest, ScheduleUpdateRequest, ScheduleExecutionLog, ScheduleExecutionLogResponse } from '../schedule-types'
import type { BackupConfig, BackupListResponse, BackupCreateRequest, BackupRestoreRequest, SettingsConfig, SettingsUpdateRequest, LogListResponse, LogQueryRequest } from '../settings-types'

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
 * 模型配置下发入参(渲染层本地手填,主进程落盘并下发给 echo-agent)
 */
export interface ModelConfigInput {
  baseUrl: string
  apiKey: string
  model: string
}

/**
 * 项目记忆本地镜像行(与 echo-agent 项目记忆双向同步的本地副本)
 */
export interface ProjectMemoryMirrorRow {
  serverId: string
  content: string
  tags: string[]
  version: number
  updatedAt: number
}

/**
 * 只读 echo-agent 认知记忆条目
 */
export interface EchoCognitiveEntry {
  id: string
  content: string
  tags: string[]
  importance: number
}

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
    example: {
      /** 查询全部示例记录(按创建时间倒序) */
      list: () => Promise<ExampleRecord[]>
      /** 新增一条示例记录,返回完整记录 */
      add: (content: string) => Promise<ExampleRecord>
      /** 删除指定记录 */
      remove: (id: number) => Promise<void>
      /** 清空示例表 */
      clear: () => Promise<void>
    }
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
    /** 通用 HTTP 代理(绕过 CORS,P6 从 agent 段迁入) */
    httpProxy: (opts: {
      url: string
      method?: string
      headers?: Record<string, string>
      body?: string
      /** 单次请求超时(ms),默认 30000 */
      timeoutMs?: number
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

  /** 本地语音识别(sherpa-onnx 离线 ASR) */
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
  }

  /** 原生 agent 对话主链路(P5) */
  agentChat: {
    send(
      chatId: string,
      text: string,
      attachments?: Array<{ id: string; name: string }>
    ): Promise<void>
    abort(chatId: string): Promise<void>
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
    onEvent(handler: (ev: Record<string, unknown>) => void): () => void
  }

  /** Agent 工具权限审批(受限档逐次授权) */
  agentPermission: {
    onRequest(handler: (req: PermissionRequest) => void): () => void
    respond(res: PermissionResponse): Promise<{ ok: boolean }>
  }

  /** 认知记忆 IPC(P3) */
  agentMemory: {
    list(opts: { limit: number; offset: number }): Promise<Array<Record<string, unknown>>>
    search(opts: { query: string; topK?: number }): Promise<Array<Record<string, unknown>>>
    get(id: number): Promise<{ record: Record<string, unknown>; provenance: Record<string, unknown> | null } | null>
    update(
      id: number,
      patch: { content?: string; importance?: number; keywords?: string[]; tags?: string[]; contextDesc?: string }
    ): Promise<{ success: boolean }>
    delete(id: number): Promise<{ success: boolean }>
    stats(): Promise<{
      total: number
      byTier: Record<string, number>
      byType: Record<string, number>
      avgConfidence: number
      linkCount: number
      episodeCount: number
      unconsolidatedCount: number
    }>
  }

  /** 技能 IPC(P4) */
  agentSkill: {
    list(): Promise<Array<{ id: string; label: string; description: string; kind: 'prompt' | 'code' }>>
    active(chatId: string): Promise<string[]>
    activate(chatId: string, skillId: string): Promise<{ success: boolean }>
    deactivate(chatId: string, skillId: string): Promise<{ success: boolean }>
  }

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
  }

  /** echo-agent 进程生命周期 */
  echoAgent: {
    /** 读取当前进程状态 */
    getStatus: () => Promise<EchoAgentStatus>
    /** 读取当前安装的 echo-agent Python 包版本 */
    getVersion: () => Promise<string | null>
    /** 触发依赖更新 */
    update: () => Promise<void>
    /** 监听状态变化,返回取消监听函数 */
    onStatusChanged: (cb: (s: EchoAgentStatus) => void) => () => void
  }

  /** echo-agent 模型配置下发 */
  echoConfig: {
    /** 下发模型配置(baseUrl/apiKey/model) */
    apply: (cfg: ModelConfigInput) => Promise<void>
  }

  /** 项目记忆本地镜像 CRUD(与 echo-agent 双向同步) */
  projectMemory: {
    /** 读取全部本地镜像行 */
    listMirror: () => Promise<ProjectMemoryMirrorRow[]>
    /** 新增或更新一条镜像行 */
    upsertMirror: (row: ProjectMemoryMirrorRow) => Promise<void>
    /** 删除指定镜像行 */
    deleteMirror: (serverId: string) => Promise<void>
  }

  /** 只读 echo-agent 认知记忆 */
  echoMemory: {
    /** 读取认知记忆条目(可选条数上限) */
    list: (limit?: number) => Promise<EchoCognitiveEntry[]>
  }

  /** 模型配置 CRUD */
  models: {
    /** 查询全部模型配置 */
    list: () => Promise<ModelListResponse>
    /** 查询单个模型配置 */
    get: (id: string) => Promise<ModelConfig | null>
    /** 新增模型配置 */
    add: (request: ModelAddRequest) => Promise<ModelConfig>
    /** 更新模型配置 */
    update: (request: ModelUpdateRequest) => Promise<ModelConfig>
    /** 删除模型配置 */
    remove: (id: string) => Promise<void>
    /** 设置活跃模型 */
    setActive: (id: string) => Promise<void>
  }

  /** 提供商配置 CRUD */
  providers: {
    /** 查询全部提供商配置 */
    list: () => Promise<ProviderListResponse>
    /** 查询单个提供商配置 */
    get: (id: string) => Promise<ProviderConfig | null>
    /** 新增提供商配置 */
    add: (request: ProviderAddRequest) => Promise<ProviderConfig>
    /** 更新提供商配置 */
    update: (request: ProviderUpdateRequest) => Promise<ProviderConfig>
    /** 删除提供商配置 */
    remove: (id: string) => Promise<void>
    /** 测试提供商连接 */
    test: (request: ProviderTestRequest) => Promise<ProviderTestResult>
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

  /** 定时任务管理 CRUD + 执行日志 */
  schedules: {
    /** 查询全部定时任务 */
    list: () => Promise<ScheduleListResponse>
    /** 查询单个定时任务 */
    get: (id: string) => Promise<ScheduleConfig | null>
    /** 新增定时任务 */
    add: (request: ScheduleAddRequest) => Promise<ScheduleConfig>
    /** 更新定时任务 */
    update: (request: ScheduleUpdateRequest) => Promise<ScheduleConfig>
    /** 删除定时任务 */
    delete: (id: string) => Promise<void>
    /** 切换定时任务启用状态 */
    toggle: (id: string) => Promise<ScheduleConfig>
    /** 查询执行日志 */
    listLogs: (scheduleId: string) => Promise<ScheduleExecutionLogResponse>
    /** 添加执行日志 */
    addLog: (log: Omit<ScheduleExecutionLog, 'id'>) => Promise<ScheduleExecutionLog>
  }
}
