/**
 * 主进程与渲染层共享的业务类型
 */

/** 用户信息(本地缓存) */
export interface UserInfo {
  /** 用户唯一 ID */
  id: string
  /** 昵称 */
  nickname: string
  /** 头像地址 */
  avatar?: string
  /** 邮箱 */
  email?: string
}

/** 应用设置(本地持久化) */
export interface AppSettings {
  /** 界面语言 */
  language: 'zh-CN' | 'en-US'
  /** 主题模式 */
  theme: 'light' | 'dark' | 'system'
  /** 是否开机自启 */
  launchAtLogin: boolean
}

/** 媒体类权限类型 */
export type MediaPermissionType = 'microphone' | 'camera' | 'screen'

/** 权限状态 */
export type PermissionStatus = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'

/** 日志级别 */
export type LogLevel = 'info' | 'warn' | 'error' | 'debug'

/** 数据库示例记录(pages/Example 演示用) */
export interface ExampleRecord {
  /** 自增主键 */
  id: number
  /** 记录内容 */
  content: string
  /** 创建时间(毫秒时间戳) */
  createdAt: number
}

/** 本地会话记录 */
export interface ChatSessionRecord {
  chatId: string
  title: string | null
  platform: string
  createdAt: number
  lastActivity: number
  messageCount: number
  pinned: number
}

/** 本地会话消息记录 */
export interface ChatMessageRecord {
  id: number
  chatId: string
  role: string
  content: string
  reasoning: string | null
  createdAt: number
}

/** 系统通知参数 */
export interface NotifyOptions {
  /** 通知标题 */
  title: string
  /** 通知正文 */
  body?: string
  /** 是否静音 */
  silent?: boolean
}

/** 文件选择对话框参数(精简版,够用即可) */
export interface OpenDialogOptions {
  /** 对话框标题 */
  title?: string
  /** 文件过滤器,如 [{ name: 'Images', extensions: ['png', 'jpg'] }] */
  filters?: { name: string; extensions: string[] }[]
  /** 选择模式 */
  properties?: ('openFile' | 'openDirectory' | 'multiSelections')[]
}

/** 文件保存对话框参数 */
export interface SaveDialogOptions {
  /** 对话框标题 */
  title?: string
  /** 默认文件名 */
  defaultPath?: string
  /** 文件过滤器 */
  filters?: { name: string; extensions: string[] }[]
}

export type {
  AgentProcessStatus,
  AgentStartResult,
  AgentConnectionConfig,
  ModelProviderConfig,
  AgentConfig,
  AccessScope,
  AgentScopeConfig,
  PermissionRequest,
  PermissionResponse,
  ApprovalChoice
} from './agent'

export type { MeetingDTO, SegmentDTO, SummaryDTO, MeetingSummaryInput } from './meeting'
