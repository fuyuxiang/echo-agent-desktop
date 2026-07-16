import { describe, it, expect } from 'vitest'
import type { ProviderConfig, ProviderTestResult, ProviderListResponse, ProviderAddRequest, ProviderUpdateRequest, ProviderTestRequest } from '../provider-types'
import { ProviderType } from '../provider-types'

describe('Provider Types', () => {
  it('should define ProviderType enum', () => {
    expect(ProviderType.OPENAI).toBe('openai')
    expect(ProviderType.ANTHROPIC).toBe('anthropic')
    expect(ProviderType.GOOGLE).toBe('google')
    expect(ProviderType.OPENROUTER).toBe('openrouter')
    expect(ProviderType.CUSTOM).toBe('custom')
  })

  it('should define ProviderConfig interface', () => {
    const provider: ProviderConfig = {
      id: 'provider-1',
      name: 'OpenAI',
      type: 'openai',
      apiKey: 'sk-test-key',
      baseUrl: 'https://api.openai.com/v1',
      isActive: true,
      models: ['gpt-4', 'gpt-3.5-turbo'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    expect(provider).toBeDefined()
    expect(provider.id).toBe('provider-1')
    expect(provider.type).toBe('openai')
    expect(provider.models).toEqual(['gpt-4', 'gpt-3.5-turbo'])
  })

  it('should support optional fields in ProviderConfig', () => {
    const provider: ProviderConfig = {
      id: 'provider-2',
      name: 'Custom Provider',
      type: ProviderType.CUSTOM,
      isActive: true,
      models: [],
      description: 'A custom provider',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    expect(provider.apiKey).toBeUndefined()
    expect(provider.baseUrl).toBeUndefined()
    expect(provider.description).toBe('A custom provider')
  })

  it('should define ProviderTestResult interface', () => {
    const result: ProviderTestResult = {
      success: true,
      message: 'Connection successful',
      latency: 150
    }
    expect(result).toBeDefined()
    expect(result.success).toBe(true)
    expect(result.message).toBe('Connection successful')
    expect(result.latency).toBe(150)
  })

  it('should support error field in ProviderTestResult', () => {
    const result: ProviderTestResult = {
      success: false,
      message: 'Connection failed',
      error: 'Invalid API key'
    }
    expect(result.success).toBe(false)
    expect(result.error).toBe('Invalid API key')
  })

  it('should define ProviderListResponse interface', () => {
    const response: ProviderListResponse = {
      providers: [],
      total: 0
    }
    expect(response).toBeDefined()
    expect(response.providers).toEqual([])
    expect(response.total).toBe(0)
  })

  it('should define ProviderAddRequest interface', () => {
    const request: ProviderAddRequest = {
      name: 'New Provider',
      type: ProviderType.OPENAI,
      apiKey: 'sk-xxx',
      baseUrl: 'https://api.openai.com/v1',
      models: ['gpt-4']
    }
    expect(request).toBeDefined()
    expect(request.name).toBe('New Provider')
    expect(request.type).toBe('openai')
  })

  it('should support optional fields in ProviderAddRequest', () => {
    const request: ProviderAddRequest = {
      name: 'Minimal Provider',
      type: 'custom'
    }
    expect(request.apiKey).toBeUndefined()
    expect(request.baseUrl).toBeUndefined()
    expect(request.models).toBeUndefined()
    expect(request.description).toBeUndefined()
  })

  it('should define ProviderUpdateRequest interface', () => {
    const request: ProviderUpdateRequest = {
      id: 'provider-1',
      name: 'Updated Name',
      isActive: false
    }
    expect(request).toBeDefined()
    expect(request.id).toBe('provider-1')
    expect(request.name).toBe('Updated Name')
    expect(request.isActive).toBe(false)
  })

  it('should define ProviderTestRequest interface', () => {
    const request: ProviderTestRequest = {
      id: 'provider-1',
      testMessage: 'Hello'
    }
    expect(request).toBeDefined()
    expect(request.id).toBe('provider-1')
    expect(request.testMessage).toBe('Hello')
  })

  it('should support optional testMessage in ProviderTestRequest', () => {
    const request: ProviderTestRequest = {
      id: 'provider-1'
    }
    expect(request.testMessage).toBeUndefined()
  })
})
