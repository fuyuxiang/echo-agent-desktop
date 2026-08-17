export type ThemeMode = 'light' | 'dark' | 'system'

/**
 * Agent 运行模式:
 *   - 'python' 唯一受支持的模式(方案 7.1)。Python echo-agent 进程作为
 *     唯一 Agent 内核,承担记忆/检索/工具调用。
 *   - 'legacy-ts' 二期删除的过渡 fallback。当前阶段保留以避免一次性
 *     删除阻塞首期验收,但默认不启用。
 *
 * 真正的运行时分发见 `src/main/echo-agent/manager.ts` —— 它只走 Python 路径,
 * 这里仅作为类型层面的过渡标识。
 */
export type AgentRuntime = 'python' | 'legacy-ts'

export interface NetworkConfig {
  proxy?: string
  timeout: number
  retryCount?: number
}

export interface SettingsConfig {
  id: string
  theme: ThemeMode
  language: string
  network: NetworkConfig
  /**
   * Agent 运行时选择。当前实现固定 'python';'legacy-ts' 仅用于过渡标记。
   */
  agentRuntime: AgentRuntime
  metadata?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface BackupConfig {
  id: string
  name: string
  size: number
  description?: string
  metadata?: Record<string, unknown>
  createdAt: string
}

export interface BackupListResponse {
  backups: BackupConfig[]
  total: number
}

export interface BackupCreateRequest {
  name: string
  description?: string
}

export interface BackupRestoreRequest {
  id: string
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  id: string
  level: LogLevel
  message: string
  timestamp: string
  metadata?: Record<string, unknown>
}

export interface LogListResponse {
  logs: LogEntry[]
  total: number
}

export interface LogQueryRequest {
  level?: LogLevel
  startTime?: string
  endTime?: string
  limit?: number
  offset?: number
}

export interface ThemeConfig {
  mode: ThemeMode
  primaryColor?: string
}

export interface SettingsUpdateRequest {
  id: string
  theme?: ThemeMode
  language?: string
  network?: NetworkConfig
  agentRuntime?: AgentRuntime
  metadata?: Record<string, unknown>
}
