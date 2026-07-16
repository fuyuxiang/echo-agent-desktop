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

  if (!provider.baseUrl) {
    return {
      success: false,
      message: '未配置 baseUrl',
      error: 'Provider 未设置 baseUrl，无法测试连接'
    }
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)

    const startTime = Date.now()
    const url = `${provider.baseUrl.replace(/\/+$/, '')}/v1/models`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }
    if (provider.apiKey) {
      headers['Authorization'] = `Bearer ${provider.apiKey}`
    }

    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal
    })

    clearTimeout(timeout)
    const latency = Date.now() - startTime

    if (response.ok) {
      const data = (await response.json()) as { data?: unknown[] }
      return {
        success: true,
        message: `连接成功，发现 ${data.data?.length ?? 0} 个模型`,
        latency
      }
    } else {
      return {
        success: false,
        message: `HTTP ${response.status}: ${response.statusText}`,
        latency
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { success: false, message: '连接超时（10秒）' }
    }
    return {
      success: false,
      message: '连接失败',
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}
