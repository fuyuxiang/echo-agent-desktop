export interface SessionConfig {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
  isActive: boolean
  metadata?: Record<string, unknown>
}

export interface SessionMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  metadata?: Record<string, unknown>
}

export interface SessionListResponse {
  sessions: SessionConfig[]
  total: number
  groupedByDate: {
    today: SessionConfig[]
    yesterday: SessionConfig[]
    thisWeek: SessionConfig[]
    older: SessionConfig[]
  }
}

export interface SessionSearchRequest {
  query: string
  limit?: number
  offset?: number
}

export interface SessionSearchResponse {
  results: SessionConfig[]
  total: number
  query: string
}

export interface SessionExportData {
  session: SessionConfig
  messages: SessionMessage[]
  exportedAt: string
  version: string
}

export interface SessionImportData {
  session: SessionConfig
  messages: SessionMessage[]
}

export interface SessionUpdateRequest {
  id: string
  title?: string
  metadata?: Record<string, unknown>
}
