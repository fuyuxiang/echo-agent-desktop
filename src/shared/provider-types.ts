export enum ProviderType {
  OPENAI = 'openai',
  ANTHROPIC = 'anthropic',
  GOOGLE = 'google',
  OPENROUTER = 'openrouter',
  CUSTOM = 'custom'
}

export interface ProviderConfig {
  id: string
  name: string
  type: ProviderType | string
  apiKey?: string
  baseUrl?: string
  isActive: boolean
  models: string[]
  description?: string
  createdAt: string
  updatedAt: string
}

export interface ProviderTestResult {
  success: boolean
  message: string
  latency?: number
  error?: string
}

export interface ProviderListResponse {
  providers: ProviderConfig[]
  total: number
}

export interface ProviderAddRequest {
  name: string
  type: ProviderType | string
  apiKey?: string
  baseUrl?: string
  models?: string[]
  description?: string
}

export interface ProviderUpdateRequest {
  id: string
  name?: string
  type?: ProviderType | string
  apiKey?: string
  baseUrl?: string
  models?: string[]
  isActive?: boolean
  description?: string
}

export interface ProviderTestRequest {
  id: string
  testMessage?: string
}
