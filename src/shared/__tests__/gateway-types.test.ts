import { describe, it, expect } from 'vitest'
import type {
  GatewayPlatform,
  GatewayConfig,
  GatewayStatus,
  GatewayMessage,
  GatewayListResponse,
  GatewayConfigAddRequest,
  GatewayConfigUpdateRequest,
  GatewayTestRequest,
  GatewayTestResult
} from '../gateway-types'

describe('Gateway Types', () => {
  it('should define GatewayPlatform interface', () => {
    const platform: GatewayPlatform = {
      id: 'telegram',
      name: 'Telegram',
      type: 'messaging',
      isActive: true,
      config: {}
    }
    expect(platform).toBeDefined()
    expect(platform.id).toBe('telegram')
    expect(platform.name).toBe('Telegram')
    expect(platform.type).toBe('messaging')
    expect(platform.isActive).toBe(true)
  })

  it('should define GatewayConfig interface', () => {
    const config: GatewayConfig = {
      id: 'config-1',
      platformId: 'telegram',
      apiKey: 'test-key',
      webhookUrl: 'https://example.com/webhook',
      isActive: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    expect(config).toBeDefined()
    expect(config.platformId).toBe('telegram')
    expect(config.apiKey).toBe('test-key')
    expect(config.webhookUrl).toBe('https://example.com/webhook')
  })

  it('should define GatewayStatus interface', () => {
    const status: GatewayStatus = {
      platformId: 'telegram',
      isConnected: true,
      lastConnectedAt: new Date().toISOString(),
      errorCount: 0
    }
    expect(status).toBeDefined()
    expect(status.isConnected).toBe(true)
    expect(status.errorCount).toBe(0)
  })

  it('should define GatewayMessage interface', () => {
    const message: GatewayMessage = {
      id: 'msg-1',
      platformId: 'telegram',
      direction: 'inbound',
      content: 'Hello World',
      timestamp: new Date().toISOString()
    }
    expect(message).toBeDefined()
    expect(message.direction).toBe('inbound')
    expect(message.content).toBe('Hello World')
  })

  it('should define GatewayListResponse interface', () => {
    const response: GatewayListResponse = {
      platforms: [],
      configs: [],
      statuses: [],
      total: 0
    }
    expect(response).toBeDefined()
    expect(response.total).toBe(0)
  })

  it('should define GatewayConfigAddRequest interface', () => {
    const request: GatewayConfigAddRequest = {
      platformId: 'telegram',
      apiKey: 'test-key',
      webhookUrl: 'https://example.com/webhook'
    }
    expect(request).toBeDefined()
    expect(request.platformId).toBe('telegram')
  })

  it('should define GatewayConfigUpdateRequest interface', () => {
    const request: GatewayConfigUpdateRequest = {
      id: 'config-1',
      apiKey: 'new-key',
      isActive: false
    }
    expect(request).toBeDefined()
    expect(request.id).toBe('config-1')
  })

  it('should define GatewayTestRequest interface', () => {
    const request: GatewayTestRequest = {
      platformId: 'telegram',
      message: 'test message'
    }
    expect(request).toBeDefined()
    expect(request.platformId).toBe('telegram')
  })

  it('should define GatewayTestResult interface', () => {
    const result: GatewayTestResult = {
      success: true,
      message: 'Connection successful',
      latency: 150
    }
    expect(result).toBeDefined()
    expect(result.success).toBe(true)
    expect(result.latency).toBe(150)
  })
})