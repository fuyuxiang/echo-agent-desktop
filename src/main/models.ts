import { randomUUID } from 'crypto'
import type {
  ModelConfig,
  ModelListResponse,
  ModelAddRequest,
  ModelUpdateRequest
} from '../shared/model-types'
import { storeGet, storeSet } from './store'

/** 读取模型列表 */
function getModels(): ModelConfig[] {
  return storeGet<ModelConfig[]>('models.models') ?? []
}

/** 读取当前激活模型 ID */
function getActiveModelId(): string | null {
  return storeGet<string | null>('models.activeModelId') ?? null
}

export async function listModels(): Promise<ModelListResponse> {
  const models = getModels()
  return {
    models,
    total: models.length
  }
}

export async function getModel(id: string): Promise<ModelConfig | null> {
  const models = getModels()
  return models.find(m => m.id === id) || null
}

export async function addModel(request: ModelAddRequest): Promise<ModelConfig> {
  const models = getModels()
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
  storeSet('models.models', models)
  if (isFirstModel) {
    storeSet('models.activeModelId', newModel.id)
  }
  return newModel
}

export async function updateModel(request: ModelUpdateRequest): Promise<ModelConfig> {
  const models = getModels()
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
  storeSet('models.models', models)
  return updated
}

export async function removeModel(id: string): Promise<void> {
  const models = getModels()
  const filtered = models.filter(m => m.id !== id)
  if (getActiveModelId() === id) {
    const newActiveId = filtered.length > 0 ? filtered[0].id : null
    const updated = filtered.map(m => ({
      ...m,
      isActive: m.id === newActiveId
    }))
    storeSet('models.models', updated)
    storeSet('models.activeModelId', newActiveId)
  } else {
    storeSet('models.models', filtered)
  }
}

export async function setActiveModel(id: string): Promise<void> {
  const models = getModels()
  const updated = models.map(m => ({
    ...m,
    isActive: m.id === id
  }))
  storeSet('models.models', updated)
  storeSet('models.activeModelId', id)
}
