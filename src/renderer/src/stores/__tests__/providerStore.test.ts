import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useProviderStore } from '../providerStore'
import type { ProviderConfig, ProviderTestResult } from '@shared/provider-types'

// Mock window.api.providers
const mockProviders: ProviderConfig[] = [
  {
    id: '1',
    name: 'OpenAI',
    type: 'openai',
    apiKey: 'sk-test-key',
    baseUrl: 'https://api.openai.com/v1',
    isActive: true,
    models: ['gpt-4', 'gpt-3.5-turbo'],
    description: 'OpenAI provider',
    createdAt: '2026-07-16T00:00:00Z',
    updatedAt: '2026-07-16T00:00:00Z'
  },
  {
    id: '2',
    name: 'Anthropic',
    type: 'anthropic',
    apiKey: 'sk-ant-test-key',
    baseUrl: 'https://api.anthropic.com',
    isActive: false,
    models: ['claude-3-opus', 'claude-3-sonnet'],
    description: 'Anthropic provider',
    createdAt: '2026-07-16T00:00:00Z',
    updatedAt: '2026-07-16T00:00:00Z'
  }
]

const mockNewProvider: ProviderConfig = {
  id: '3',
  name: 'Google',
  type: 'google',
  apiKey: 'test-google-key',
  baseUrl: 'https://generativelanguage.googleapis.com',
  isActive: false,
  models: ['gemini-pro'],
  description: 'Google AI provider',
  createdAt: '2026-07-16T00:00:00Z',
  updatedAt: '2026-07-16T00:00:00Z'
}

const mockTestResult: ProviderTestResult = {
  success: true,
  message: 'Connection successful',
  latency: 150
}

// Setup window.api mock
beforeEach(() => {
  vi.stubGlobal('window', {
    api: {
      providers: {
        list: vi.fn().mockResolvedValue({ providers: mockProviders, total: mockProviders.length }),
        get: vi.fn().mockImplementation((id: string) =>
          Promise.resolve(mockProviders.find(p => p.id === id) || null)
        ),
        add: vi.fn().mockResolvedValue(mockNewProvider),
        update: vi.fn().mockImplementation((request: { id: string; name?: string }) => {
          const provider = mockProviders.find(p => p.id === request.id)
          if (provider) {
            return Promise.resolve({ ...provider, ...request })
          }
          return Promise.reject(new Error('Provider not found'))
        }),
        remove: vi.fn().mockResolvedValue(undefined),
        test: vi.fn().mockResolvedValue(mockTestResult)
      }
    }
  })

  // Reset store state
  useProviderStore.setState({
    providers: [],
    loading: false,
    error: null
  })
})

describe('Provider Store', () => {
  it('should have initial state', () => {
    const state = useProviderStore.getState()
    expect(state.providers).toEqual([])
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
  })

  it('should fetch providers', async () => {
    await useProviderStore.getState().fetchProviders()
    const state = useProviderStore.getState()
    expect(state.providers).toEqual(mockProviders)
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
  })

  it('should set loading state during fetch', async () => {
    const fetchPromise = useProviderStore.getState().fetchProviders()
    const loadingState = useProviderStore.getState()
    expect(loadingState.loading).toBe(true)
    expect(loadingState.error).toBeNull()
    await fetchPromise
  })

  it('should handle fetch error', async () => {
    const errorMessage = 'Failed to fetch providers'
    vi.mocked(window.api.providers.list).mockRejectedValueOnce(new Error(errorMessage))

    await useProviderStore.getState().fetchProviders()
    const state = useProviderStore.getState()
    expect(state.providers).toEqual([])
    expect(state.loading).toBe(false)
    expect(state.error).toBe(errorMessage)
  })

  it('should add a provider', async () => {
    const request = {
      name: 'Google',
      type: 'google',
      apiKey: 'test-google-key',
      baseUrl: 'https://generativelanguage.googleapis.com',
      models: ['gemini-pro'],
      description: 'Google AI provider'
    }

    await useProviderStore.getState().addProvider(request)
    const state = useProviderStore.getState()
    expect(state.providers).toContainEqual(mockNewProvider)
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
  })

  it('should handle add error', async () => {
    const errorMessage = 'Failed to add provider'
    vi.mocked(window.api.providers.add).mockRejectedValueOnce(new Error(errorMessage))

    const request = {
      name: 'Test',
      type: 'custom',
      apiKey: 'test-key'
    }

    await useProviderStore.getState().addProvider(request)
    const state = useProviderStore.getState()
    expect(state.providers).toEqual([])
    expect(state.loading).toBe(false)
    expect(state.error).toBe(errorMessage)
  })

  it('should update a provider', async () => {
    // First fetch providers
    await useProviderStore.getState().fetchProviders()

    const updateRequest = {
      id: '1',
      name: 'Updated OpenAI'
    }

    await useProviderStore.getState().updateProvider(updateRequest)
    const state = useProviderStore.getState()
    const updatedProvider = state.providers.find(p => p.id === '1')
    expect(updatedProvider?.name).toBe('Updated OpenAI')
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
  })

  it('should handle update error', async () => {
    // First fetch providers
    await useProviderStore.getState().fetchProviders()

    const errorMessage = 'Failed to update provider'
    vi.mocked(window.api.providers.update).mockRejectedValueOnce(new Error(errorMessage))

    const updateRequest = {
      id: '1',
      name: 'Updated OpenAI'
    }

    await useProviderStore.getState().updateProvider(updateRequest)
    const state = useProviderStore.getState()
    expect(state.loading).toBe(false)
    expect(state.error).toBe(errorMessage)
  })

  it('should remove a provider', async () => {
    // First fetch providers
    await useProviderStore.getState().fetchProviders()
    expect(useProviderStore.getState().providers).toHaveLength(2)

    await useProviderStore.getState().removeProvider('1')
    const state = useProviderStore.getState()
    expect(state.providers).toHaveLength(1)
    expect(state.providers.find(p => p.id === '1')).toBeUndefined()
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
  })

  it('should handle remove error', async () => {
    // First fetch providers
    await useProviderStore.getState().fetchProviders()

    const errorMessage = 'Failed to remove provider'
    vi.mocked(window.api.providers.remove).mockRejectedValueOnce(new Error(errorMessage))

    await useProviderStore.getState().removeProvider('1')
    const state = useProviderStore.getState()
    expect(state.providers).toHaveLength(2) // Should not change
    expect(state.loading).toBe(false)
    expect(state.error).toBe(errorMessage)
  })

  it('should test provider connection', async () => {
    // First fetch providers
    await useProviderStore.getState().fetchProviders()

    const result = await useProviderStore.getState().testProvider('1')
    expect(result).toEqual(mockTestResult)

    const state = useProviderStore.getState()
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
  })

  it('should handle test error', async () => {
    // First fetch providers
    await useProviderStore.getState().fetchProviders()

    const errorMessage = 'Failed to test provider'
    vi.mocked(window.api.providers.test).mockRejectedValueOnce(new Error(errorMessage))

    const result = await useProviderStore.getState().testProvider('1')
    expect(result).toEqual({
      success: false,
      message: errorMessage
    })

    const state = useProviderStore.getState()
    expect(state.loading).toBe(false)
    expect(state.error).toBe(errorMessage)
  })

  it('should clear error on new operation', async () => {
    // Set an error state
    useProviderStore.setState({ error: 'Previous error' })

    await useProviderStore.getState().fetchProviders()
    const state = useProviderStore.getState()
    expect(state.error).toBeNull()
  })
})
