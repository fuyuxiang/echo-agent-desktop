export interface GatewayPlatform {
  id: string
  name: string
  type: 'messaging' | 'notification' | 'webhook'
  isActive: boolean
  config: Record<string, unknown>
  description?: string
  icon?: string
}

export interface GatewayConfig {
  id: string
  platformId: string
  apiKey?: string
  webhookUrl?: string
  isActive: boolean
  metadata?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface GatewayStatus {
  platformId: string
  isConnected: boolean
  lastConnectedAt?: string
  errorCount: number
  lastError?: string
}

export interface GatewayMessage {
  id: string
  platformId: string
  direction: 'inbound' | 'outbound'
  content: string
  timestamp: string
  metadata?: Record<string, unknown>
}

export interface GatewayListResponse {
  platforms: GatewayPlatform[]
  configs: GatewayConfig[]
  statuses: GatewayStatus[]
  total: number
}

export interface GatewayConfigAddRequest {
  platformId: string
  apiKey?: string
  webhookUrl?: string
  metadata?: Record<string, unknown>
}

export interface GatewayConfigUpdateRequest {
  id: string
  apiKey?: string
  webhookUrl?: string
  isActive?: boolean
  metadata?: Record<string, unknown>
}

export interface GatewayTestRequest {
  platformId: string
  message?: string
}

export interface GatewayTestResult {
  success: boolean
  message: string
  latency?: number
}