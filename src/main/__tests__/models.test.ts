import { beforeEach, describe, expect, it, vi } from 'vitest'

const storeMock = vi.hoisted(() => {
  const data = new Map<string, unknown>()
  class FakeStore {
    constructor(options?: { defaults?: Record<string, unknown> }) {
      if (options?.defaults) {
        for (const [key, value] of Object.entries(options.defaults)) {
          data.set(key, value)
        }
      }
    }
    get(key: string, defaultValue?: unknown): unknown {
      if (data.has(key)) {
        return data.get(key)
      }
      return defaultValue
    }
    set(key: string, value: unknown): void {
      data.set(key, value)
    }
    delete(key: string): void {
      data.delete(key)
    }
    clear(): void {
      data.clear()
    }
  }
  return { data, FakeStore }
})

vi.mock('electron-store', () => ({ default: storeMock.FakeStore }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  storeMock.data.clear()
})

describe('Models Service', () => {
  it('should list models', async () => {
    const { listModels } = await import('../models')
    const result = await listModels()
    expect(result).toBeDefined()
    expect(Array.isArray(result.models)).toBe(true)
    expect(result.total).toBe(0)
  })

  it('should add a new model', async () => {
    const { addModel, listModels } = await import('../models')
    const newModel = {
      name: 'gpt-4',
      provider: 'openai',
      contextWindow: 128000,
      maxTokens: 4096
    }
    const result = await addModel(newModel)
    expect(result).toBeDefined()
    expect(result.id).toBeDefined()
    expect(result.name).toBe('gpt-4')
    expect(result.provider).toBe('openai')
    expect(result.contextWindow).toBe(128000)
    expect(result.maxTokens).toBe(4096)
    expect(result.isActive).toBe(true) // First model should be active
    expect(result.createdAt).toBeDefined()
    expect(result.updatedAt).toBeDefined()

    const models = await listModels()
    expect(models.total).toBe(1)
  })

  it('should update a model', async () => {
    const { addModel, updateModel } = await import('../models')
    const newModel = {
      name: 'gpt-4',
      provider: 'openai',
      contextWindow: 128000,
      maxTokens: 4096
    }
    const added = await addModel(newModel)

    const updated = await updateModel({
      id: added.id,
      name: 'updated-name',
      contextWindow: 200000
    })
    expect(updated.name).toBe('updated-name')
    expect(updated.contextWindow).toBe(200000)
    expect(updated.provider).toBe('openai') // Should preserve other fields
    expect(updated.id).toBe(added.id) // Should preserve ID
  })

  it('should remove a model', async () => {
    const { addModel, removeModel, listModels } = await import('../models')
    const newModel = {
      name: 'gpt-4',
      provider: 'openai',
      contextWindow: 128000,
      maxTokens: 4096
    }
    const added = await addModel(newModel)

    await removeModel(added.id)
    const remaining = await listModels()
    expect(remaining.models.find(m => m.id === added.id)).toBeUndefined()
    expect(remaining.total).toBe(0)
  })

  it('should get a model by id', async () => {
    const { addModel, getModel } = await import('../models')
    const newModel = {
      name: 'gpt-4',
      provider: 'openai',
      contextWindow: 128000,
      maxTokens: 4096
    }
    const added = await addModel(newModel)

    const found = await getModel(added.id)
    expect(found).toBeDefined()
    expect(found?.id).toBe(added.id)
    expect(found?.name).toBe('gpt-4')
  })

  it('should set active model', async () => {
    const { addModel, setActiveModel, getModel } = await import('../models')
    const model1 = await addModel({
      name: 'gpt-4',
      provider: 'openai',
      contextWindow: 128000,
      maxTokens: 4096
    })
    const model2 = await addModel({
      name: 'claude-3',
      provider: 'anthropic',
      contextWindow: 200000,
      maxTokens: 4096
    })

    // First model should be active by default
    expect(model1.isActive).toBe(true)
    expect(model2.isActive).toBe(false)

    // Set second model as active
    await setActiveModel(model2.id)

    const found1 = await getModel(model1.id)
    const found2 = await getModel(model2.id)
    expect(found1?.isActive).toBe(false)
    expect(found2?.isActive).toBe(true)
  })

  it('should handle update for non-existent model', async () => {
    const { updateModel } = await import('../models')
    await expect(
      updateModel({
        id: 'non-existent-id',
        name: 'updated-name'
      })
    ).rejects.toThrow('Model not found: non-existent-id')
  })

  it('should handle get for non-existent model', async () => {
    const { getModel } = await import('../models')
    const found = await getModel('non-existent-id')
    expect(found).toBeNull()
  })

  it('should handle remove for non-existent model', async () => {
    const { removeModel, listModels } = await import('../models')
    // Should not throw
    await removeModel('non-existent-id')
    const models = await listModels()
    expect(models.total).toBe(0)
  })

  it('should update activeModelId when removing active model', async () => {
    const { addModel, removeModel, listModels } = await import('../models')
    const model1 = await addModel({
      name: 'gpt-4',
      provider: 'openai',
      contextWindow: 128000,
      maxTokens: 4096
    })
    const model2 = await addModel({
      name: 'claude-3',
      provider: 'anthropic',
      contextWindow: 200000,
      maxTokens: 4096
    })

    // Remove active model (model1)
    await removeModel(model1.id)

    const remaining = await listModels()
    expect(remaining.total).toBe(1)
    expect(remaining.models[0].id).toBe(model2.id)
    expect(remaining.models[0].isActive).toBe(true)
  })

  it('should handle removing last model', async () => {
    const { addModel, removeModel, listModels } = await import('../models')
    const model = await addModel({
      name: 'gpt-4',
      provider: 'openai',
      contextWindow: 128000,
      maxTokens: 4096
    })

    await removeModel(model.id)
    const remaining = await listModels()
    expect(remaining.total).toBe(0)
  })
})
