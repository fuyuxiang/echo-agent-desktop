// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelConfig } from '@shared/model-types'

function installApi() {
  const models: ModelConfig[] = []
  let nextId = 1

  const api = {
    models: {
      list: vi.fn(async () => ({ models, total: models.length })),
      get: vi.fn(async (id: string) => models.find((m) => m.id === id) || null),
      add: vi.fn(async (request: Omit<ModelConfig, 'id' | 'createdAt' | 'updatedAt'>) => {
        const newModel: ModelConfig = {
          ...request,
          id: `model-${nextId++}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
        models.push(newModel)
        return newModel
      }),
      update: vi.fn(async (request: Partial<ModelConfig> & { id: string }) => {
        const index = models.findIndex((m) => m.id === request.id)
        if (index === -1) throw new Error('Model not found')
        const updated = { ...models[index], ...request, updatedAt: new Date().toISOString() }
        models[index] = updated
        return updated
      }),
      remove: vi.fn(async (id: string) => {
        const index = models.findIndex((m) => m.id === id)
        if (index !== -1) models.splice(index, 1)
      }),
      setActive: vi.fn(async (id: string) => {
        models.forEach((m) => (m.isActive = m.id === id))
      })
    }
  }

  window.api = api as unknown as typeof window.api
  return { api, models }
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  installApi()
})

describe('Model Store', () => {
  it('should have initial state', async () => {
    const { useModelStore } = await import('../modelStore')
    const state = useModelStore.getState()
    expect(state.models).toEqual([])
    expect(state.activeModel).toBeNull()
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
  })

  it('should fetch models', async () => {
    const { useModelStore } = await import('../modelStore')
    await useModelStore.getState().fetchModels()
    const state = useModelStore.getState()
    expect(Array.isArray(state.models)).toBe(true)
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
  })

  it('should add a model', async () => {
    const { useModelStore } = await import('../modelStore')
    const newModel = {
      name: 'gpt-4',
      provider: 'openai',
      contextWindow: 128000,
      maxTokens: 4096
    }
    await useModelStore.getState().addModel(newModel)
    const state = useModelStore.getState()
    expect(state.models.length).toBe(1)
    expect(state.models[0].name).toBe('gpt-4')
    expect(state.loading).toBe(false)
  })

  it('should update a model', async () => {
    const { useModelStore } = await import('../modelStore')
    // First add a model
    await useModelStore.getState().addModel({
      name: 'gpt-4',
      provider: 'openai',
      contextWindow: 128000,
      maxTokens: 4096
    })
    const model = useModelStore.getState().models[0]

    // Then update it
    await useModelStore.getState().updateModel({
      id: model.id,
      name: 'updated-name'
    })
    const updatedState = useModelStore.getState()
    const updatedModel = updatedState.models.find((m) => m.id === model.id)
    expect(updatedModel?.name).toBe('updated-name')
  })

  it('should remove a model', async () => {
    const { useModelStore } = await import('../modelStore')
    // First add a model
    await useModelStore.getState().addModel({
      name: 'gpt-4',
      provider: 'openai',
      contextWindow: 128000,
      maxTokens: 4096
    })
    const model = useModelStore.getState().models[0]

    // Then remove it
    await useModelStore.getState().removeModel(model.id)
    const updatedState = useModelStore.getState()
    expect(updatedState.models.find((m) => m.id === model.id)).toBeUndefined()
  })

  it('should set active model', async () => {
    const { useModelStore } = await import('../modelStore')
    // First add two models
    await useModelStore.getState().addModel({
      name: 'gpt-4',
      provider: 'openai',
      contextWindow: 128000,
      maxTokens: 4096
    })
    await useModelStore.getState().addModel({
      name: 'claude-3',
      provider: 'anthropic',
      contextWindow: 200000,
      maxTokens: 4096
    })

    const model = useModelStore.getState().models[0]

    // Set the first model as active
    await useModelStore.getState().setActiveModel(model.id)
    const state = useModelStore.getState()
    expect(state.activeModel?.id).toBe(model.id)
    expect(state.models.find((m) => m.id === model.id)?.isActive).toBe(true)
    expect(state.models.find((m) => m.id !== model.id)?.isActive).toBe(false)
  })

  it('should handle loading state during async operations', async () => {
    const { useModelStore } = await import('../modelStore')

    // Start fetch
    const fetchPromise = useModelStore.getState().fetchModels()
    expect(useModelStore.getState().loading).toBe(true)

    await fetchPromise
    expect(useModelStore.getState().loading).toBe(false)
  })

  it('should handle errors gracefully', async () => {
    const { useModelStore } = await import('../modelStore')

    // Mock API to throw error
    vi.mocked(window.api.models.list).mockRejectedValueOnce(new Error('Network error'))

    await useModelStore.getState().fetchModels()
    expect(useModelStore.getState().error).toBe('Network error')
    expect(useModelStore.getState().loading).toBe(false)
  })

  it('should clear active model when removing the active model', async () => {
    const { useModelStore } = await import('../modelStore')

    // Add a model and set it as active
    await useModelStore.getState().addModel({
      name: 'gpt-4',
      provider: 'openai',
      contextWindow: 128000,
      maxTokens: 4096
    })
    const model = useModelStore.getState().models[0]
    expect(useModelStore.getState().activeModel?.id).toBe(model.id)

    // Remove the active model
    await useModelStore.getState().removeModel(model.id)
    expect(useModelStore.getState().activeModel).toBeNull()
  })
})
