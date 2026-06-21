import type {
  AgentConfig,
  AgentEnvInfo,
  AgentProcessStatus,
  AgentStartResult,
  ChatMessageRecord,
  ChatSessionRecord,
  ExampleRecord,
  InstallProgressEvent,
  LogLevel,
  MediaPermissionType,
  NotifyOptions,
  OpenDialogOptions,
  PermissionStatus,
  SaveDialogOptions
} from './index'

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
  }

  /** 日志(渲染层日志汇入主进程统一落盘) */
  log: {
    write: (level: LogLevel, message: string) => void
  }

  /** Agent 进程管理 */
  agent: {
    getEnvInfo: () => Promise<AgentEnvInfo>
    start: () => Promise<AgentStartResult>
    stop: () => Promise<void>
    restart: () => Promise<AgentStartResult>
    getStatus: () => Promise<AgentProcessStatus>
    getPort: () => Promise<number | null>
    initEnv: (pipIndex?: string) => Promise<{ success: boolean; error?: string }>
    upgrade: (pipIndex?: string) => Promise<{ success: boolean; version?: string; error?: string }>
    resetEnv: (pipIndex?: string) => Promise<{ success: boolean; error?: string }>
    updateConfig: (config: AgentConfig) => Promise<{ success: boolean }>
    getLogs: () => Promise<string>
    httpProxy: (opts: {
      url: string
      method?: string
      headers?: Record<string, string>
      body?: string
    }) => Promise<{ ok: boolean; status: number; body: string }>
    onStatusChanged: (callback: (status: AgentProcessStatus) => void) => () => void
    onInstallProgress: (callback: (event: InstallProgressEvent) => void) => () => void
  }

  /** 本地语音识别(sherpa-onnx 离线 ASR) */
  asr: {
    start: () => Promise<string>
    feed: (streamId: string, samples: Float32Array) => Promise<void>
    getResult: (streamId: string) => Promise<string>
    stop: (streamId: string) => Promise<string>
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
}
