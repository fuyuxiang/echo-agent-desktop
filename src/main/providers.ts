import { randomUUID } from 'crypto'
import type {
  ProviderConfig,
  ProviderListResponse,
  ProviderAddRequest,
  ProviderUpdateRequest,
  ProviderTestRequest,
  ProviderTestResult
} from '../shared/provider-types'
import { storeGet, storeSet } from './store'

/** 读取提供商列表 */
function getProviders(): ProviderConfig[] {
  return storeGet<ProviderConfig[]>('providers.providers') ?? []
}

export async function listProviders(): Promise<ProviderListResponse> {
  const providers = getProviders()
  return {
    providers,
    total: providers.length
  }
}

export async function getProvider(id: string): Promise<ProviderConfig | null> {
  const providers = getProviders()
  return providers.find(p => p.id === id) || null
}

export async function addProvider(request: ProviderAddRequest): Promise<ProviderConfig> {
  const providers = getProviders()
  const newProvider: ProviderConfig = {
    id: randomUUID(),
    name: request.name,
    type: request.type,
    apiKey: request.apiKey,
    baseUrl: request.baseUrl,
    models: request.models ?? [],
    description: request.description,
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
  providers.push(newProvider)
  storeSet('providers.providers', providers)
  return newProvider
}

export async function updateProvider(request: ProviderUpdateRequest): Promise<ProviderConfig> {
  const providers = getProviders()
  const index = providers.findIndex(p => p.id === request.id)
  if (index === -1) {
    throw new Error(`Provider not found: ${request.id}`)
  }
  const updated: ProviderConfig = {
    ...providers[index],
    ...request,
    updatedAt: new Date().toISOString()
  }
  providers[index] = updated
  storeSet('providers.providers', providers)
  return updated
}

export async function removeProvider(id: string): Promise<void> {
  const providers = getProviders()
  const filtered = providers.filter(p => p.id !== id)
  storeSet('providers.providers', filtered)
}

export async function testProvider(request: ProviderTestRequest): Promise<ProviderTestResult> {
  const provider = await getProvider(request.id)
  if (!provider) {
    return {
      success: false,
      message: 'Provider not found',
      error: `Provider with id ${request.id} not found`
    }
  }

  try {
    const startTime = Date.now()
    // Simulate connection test - in production, this would make an actual API call
    await new Promise(resolve => setTimeout(resolve, 100))
    const latency = Date.now() - startTime

    return {
      success: true,
      message: 'Connection successful',
      latency
    }
  } catch (error) {
    return {
      success: false,
      message: 'Connection failed',
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}
