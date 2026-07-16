export type ThemeMode = 'light' | 'dark' | 'system'

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
  metadata?: Record<string, unknown>
}
