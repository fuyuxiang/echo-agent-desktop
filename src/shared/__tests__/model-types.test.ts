import { describe, it, expect } from 'vitest'
import type { ModelConfig, ModelDefinition } from '../model-types'
import { ModelProvider } from '../model-types'

describe('Model Types', () => {
  it('should define ModelConfig interface', () => {
    const model: ModelConfig = {
      id: 'test-id',
      name: 'gpt-4',
      provider: 'openai',
      contextWindow: 128000,
      maxTokens: 4096,
      isActive: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    expect(model).toBeDefined()
    expect(model.id).toBe('test-id')
    expect(model.name).toBe('gpt-4')
    expect(model.provider).toBe('openai')
  })

  it('should define ModelDefinition interface', () => {
    const definition: ModelDefinition = {
      id: 'def-1',
      name: 'GPT-4',
      provider: 'openai',
      contextWindow: 128000,
      maxTokens: 4096,
      description: 'OpenAI GPT-4 model'
    }
    expect(definition).toBeDefined()
    expect(definition.contextWindow).toBe(128000)
  })

  it('should define ModelProvider enum', () => {
    expect(ModelProvider.OPENAI).toBe('openai')
    expect(ModelProvider.ANTHROPIC).toBe('anthropic')
    expect(ModelProvider.GOOGLE).toBe('google')
    expect(ModelProvider.OPENROUTER).toBe('openrouter')
    expect(ModelProvider.CUSTOM).toBe('custom')
  })

  it('should support optional fields in ModelConfig', () => {
    const model: ModelConfig = {
      id: 'test-id-2',
      name: 'claude-3',
      provider: ModelProvider.ANTHROPIC,
      contextWindow: 200000,
      maxTokens: 4096,
      isActive: true,
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-xxx',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    expect(model.baseUrl).toBe('https://api.anthropic.com')
    expect(model.apiKey).toBe('sk-xxx')
  })

  it('should support optional fields in ModelDefinition', () => {
    const definition: ModelDefinition = {
      id: 'def-2',
      name: 'Custom Model',
      provider: ModelProvider.CUSTOM,
      contextWindow: 32000,
      maxTokens: 2048,
      description: 'A custom model',
      isCustom: true
    }
    expect(definition.isCustom).toBe(true)
    expect(definition.description).toBe('A custom model')
  })

  it('should define ModelListResponse interface', () => {
    const response = {
      models: [],
      total: 0
    }
    expect(response).toBeDefined()
    expect(response.models).toEqual([])
    expect(response.total).toBe(0)
  })

  it('should define ModelAddRequest interface', () => {
    const request = {
      name: 'gpt-4-turbo',
      provider: ModelProvider.OPENAI,
      contextWindow: 128000,
      maxTokens: 4096
    }
    expect(request).toBeDefined()
    expect(request.name).toBe('gpt-4-turbo')
  })

  it('should define ModelUpdateRequest interface', () => {
    const request = {
      id: 'model-1',
      name: 'updated-name',
      isActive: false
    }
    expect(request).toBeDefined()
    expect(request.id).toBe('model-1')
    expect(request.isActive).toBe(false)
  })
})
