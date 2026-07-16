export interface SoulConfig {
  id: string
  name: string
  content: string
  isActive: boolean
  metadata?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface SoulTemplate {
  id: string
  name: string
  content: string
  category: string
  description?: string
}

export interface SoulListResponse {
  souls: SoulConfig[]
  templates: SoulTemplate[]
  total: number
}

export interface SoulUpdateRequest {
  id: string
  name?: string
  content?: string
  isActive?: boolean
  metadata?: Record<string, unknown>
}

export interface SoulAddRequest {
  name: string
  content: string
  metadata?: Record<string, unknown>
}
