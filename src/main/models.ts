import Store from 'electron-store'
import { randomUUID } from 'crypto'
import type {
  ModelConfig,
  ModelListResponse,
  ModelAddRequest,
  ModelUpdateRequest
} from '../shared/model-types'

interface ModelsStore {
  models: ModelConfig[]
  activeModelId: string | null
}

const store = new Store<ModelsStore>({
  name: 'models',
  defaults: {
    models: [],
    activeModelId: null
  }
})

export async function listModels(): Promise<ModelListResponse> {
  const models = store.get('models', [])
  return {
    models,
    total: models.length
  }
}

export async function getModel(id: string): Promise<ModelConfig | null> {
  const models = store.get('models', [])
  return models.find(m => m.id === id) || null
}

export async function addModel(request: ModelAddRequest): Promise<ModelConfig> {
  const models = store.get('models', [])
  const isFirstModel = models.length === 0
  const newModel: ModelConfig = {
    id: randomUUID(),
    name: request.name,
    provider: request.provider,
    contextWindow: request.contextWindow,
    maxTokens: request.maxTokens,
    baseUrl: request.baseUrl,
    apiKey: request.apiKey,
    isActive: isFirstModel, // First model is active by default
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
  models.push(newModel)
  store.set('models', models)
  if (isFirstModel) {
    store.set('activeModelId', newModel.id)
  }
  return newModel
}

export async function updateModel(request: ModelUpdateRequest): Promise<ModelConfig> {
  const models = store.get('models', [])
  const index = models.findIndex(m => m.id === request.id)
  if (index === -1) {
    throw new Error(`Model not found: ${request.id}`)
  }
  const updated: ModelConfig = {
    ...models[index],
    ...request,
    updatedAt: new Date().toISOString()
  }
  models[index] = updated
  store.set('models', models)
  return updated
}

export async function removeModel(id: string): Promise<void> {
  const models = store.get('models', [])
  const filtered = models.filter(m => m.id !== id)
  if (store.get('activeModelId') === id) {
    const newActiveId = filtered.length > 0 ? filtered[0].id : null
    const updated = filtered.map(m => ({
      ...m,
      isActive: m.id === newActiveId
    }))
    store.set('models', updated)
    store.set('activeModelId', newActiveId)
  } else {
    store.set('models', filtered)
  }
}

export async function setActiveModel(id: string): Promise<void> {
  const models = store.get('models', [])
  const updated = models.map(m => ({
    ...m,
    isActive: m.id === id
  }))
  store.set('models', updated)
  store.set('activeModelId', id)
}
