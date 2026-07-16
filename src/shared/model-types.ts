export enum ModelProvider {
  OPENAI = 'openai',
  ANTHROPIC = 'anthropic',
  GOOGLE = 'google',
  OPENROUTER = 'openrouter',
  CUSTOM = 'custom'
}

export interface ModelConfig {
  id: string
  name: string
  provider: ModelProvider | string
  contextWindow: number
  maxTokens: number
  isActive: boolean
  baseUrl?: string
  apiKey?: string
  createdAt: string
  updatedAt: string
}

export interface ModelDefinition {
  id: string
  name: string
  provider: ModelProvider | string
  contextWindow: number
  maxTokens: number
  description?: string
  isCustom?: boolean
}

export interface ModelListResponse {
  models: ModelConfig[]
  total: number
}

export interface ModelAddRequest {
  name: string
  provider: ModelProvider | string
  contextWindow: number
  maxTokens: number
  baseUrl?: string
  apiKey?: string
}

export interface ModelUpdateRequest {
  id: string
  name?: string
  provider?: ModelProvider | string
  contextWindow?: number
  maxTokens?: number
  baseUrl?: string
  apiKey?: string
  isActive?: boolean
}
