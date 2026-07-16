import { beforeEach, describe, expect, it, vi } from 'vitest'

const storeMock = vi.hoisted(() => {
  const data = new Map<string, unknown>()
  return {
    data,
    storeGet: vi.fn((key: string) => data.get(key)),
    storeSet: vi.fn((key: string, value: unknown) => { data.set(key, value) })
  }
})

vi.mock('../store', () => ({
  storeGet: storeMock.storeGet,
  storeSet: storeMock.storeSet
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  storeMock.data.clear()
})

describe('Providers Service', () => {
  it('should list providers', async () => {
    const { listProviders } = await import('../providers')
    const result = await listProviders()
    expect(result).toBeDefined()
    expect(Array.isArray(result.providers)).toBe(true)
    expect(result.total).toBe(0)
  })

  it('should add a new provider', async () => {
    const { addProvider, listProviders } = await import('../providers')
    const newProvider = {
      name: 'OpenAI',
      type: 'openai',
      apiKey: 'sk-test-key',
      baseUrl: 'https://api.openai.com/v1'
    }
    const result = await addProvider(newProvider)
    expect(result).toBeDefined()
    expect(result.id).toBeDefined()
    expect(result.name).toBe('OpenAI')
    expect(result.type).toBe('openai')
    expect(result.apiKey).toBe('sk-test-key')
    expect(result.baseUrl).toBe('https://api.openai.com/v1')
    expect(result.isActive).toBe(true)
    expect(result.models).toEqual([])
    expect(result.createdAt).toBeDefined()
    expect(result.updatedAt).toBeDefined()

    const providers = await listProviders()
    expect(providers.total).toBe(1)
  })

  it('should update a provider', async () => {
    const { addProvider, updateProvider } = await import('../providers')
    const added = await addProvider({
      name: 'OpenAI',
      type: 'openai',
      apiKey: 'sk-test-key'
    })

    const updated = await updateProvider({
      id: added.id,
      name: 'Updated Name',
      apiKey: 'sk-new-key'
    })
    expect(updated.name).toBe('Updated Name')
    expect(updated.apiKey).toBe('sk-new-key')
    expect(updated.type).toBe('openai') // Should preserve other fields
    expect(updated.id).toBe(added.id) // Should preserve ID
  })

  it('should remove a provider', async () => {
    const { addProvider, removeProvider, listProviders } = await import('../providers')
    const added = await addProvider({
      name: 'OpenAI',
      type: 'openai'
    })

    await removeProvider(added.id)
    const remaining = await listProviders()
    expect(remaining.providers.find(p => p.id === added.id)).toBeUndefined()
    expect(remaining.total).toBe(0)
  })

  it('should get a provider by id', async () => {
    const { addProvider, getProvider } = await import('../providers')
    const added = await addProvider({
      name: 'OpenAI',
      type: 'openai',
      apiKey: 'sk-test-key'
    })

    const found = await getProvider(added.id)
    expect(found).toBeDefined()
    expect(found?.id).toBe(added.id)
    expect(found?.name).toBe('OpenAI')
  })

  it('should test provider connection', async () => {
    const { addProvider, testProvider } = await import('../providers')
    const added = await addProvider({
      name: 'OpenAI',
      type: 'openai',
      apiKey: 'sk-test-key'
    })

    const result = await testProvider({ id: added.id })
    expect(result).toBeDefined()
    expect(typeof result.success).toBe('boolean')
    expect(result.message).toBeDefined()
  })

  it('should handle update for non-existent provider', async () => {
    const { updateProvider } = await import('../providers')
    await expect(
      updateProvider({
        id: 'non-existent-id',
        name: 'Updated Name'
      })
    ).rejects.toThrow('Provider not found: non-existent-id')
  })

  it('should handle get for non-existent provider', async () => {
    const { getProvider } = await import('../providers')
    const found = await getProvider('non-existent-id')
    expect(found).toBeNull()
  })

  it('should handle remove for non-existent provider', async () => {
    const { removeProvider, listProviders } = await import('../providers')
    // Should not throw
    await removeProvider('non-existent-id')
    const providers = await listProviders()
    expect(providers.total).toBe(0)
  })

  it('should return error for test on non-existent provider', async () => {
    const { testProvider } = await import('../providers')
    const result = await testProvider({ id: 'non-existent-id' })
    expect(result.success).toBe(false)
    expect(result.message).toBe('Provider not found')
  })

  it('should add provider with models', async () => {
    const { addProvider } = await import('../providers')
    const result = await addProvider({
      name: 'OpenAI',
      type: 'openai',
      models: ['gpt-4', 'gpt-3.5-turbo']
    })
    expect(result.models).toEqual(['gpt-4', 'gpt-3.5-turbo'])
  })

  it('should add provider with description', async () => {
    const { addProvider } = await import('../providers')
    const result = await addProvider({
      name: 'Anthropic',
      type: 'anthropic',
      description: 'Claude AI provider'
    })
    expect(result.description).toBe('Claude AI provider')
  })

  it('should update provider isActive status', async () => {
    const { addProvider, updateProvider } = await import('../providers')
    const added = await addProvider({
      name: 'OpenAI',
      type: 'openai'
    })
    expect(added.isActive).toBe(true)

    const updated = await updateProvider({
      id: added.id,
      isActive: false
    })
    expect(updated.isActive).toBe(false)
  })

  it('should update provider models', async () => {
    const { addProvider, updateProvider } = await import('../providers')
    const added = await addProvider({
      name: 'OpenAI',
      type: 'openai',
      models: ['gpt-4']
    })

    const updated = await updateProvider({
      id: added.id,
      models: ['gpt-4', 'gpt-3.5-turbo', 'dall-e-3']
    })
    expect(updated.models).toEqual(['gpt-4', 'gpt-3.5-turbo', 'dall-e-3'])
  })
})
