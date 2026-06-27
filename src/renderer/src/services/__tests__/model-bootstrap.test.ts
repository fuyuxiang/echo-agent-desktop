// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => ({
  get: vi.fn()
}))

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}))

const server = vi.hoisted(() => ({
  fetchModelConfig: vi.fn()
}))

const agentStore = vi.hoisted(() => ({
  setReady: vi.fn(),
  setConfigured: vi.fn(),
  getState: vi.fn(() => ({ setReady: agentStore.setReady, setConfigured: agentStore.setConfigured }))
}))

vi.mock('@/utils', () => ({ storage }))
vi.mock('@/utils/logger', () => ({ logger }))
vi.mock('../server', () => server)
vi.mock('@/stores/agentStore', () => ({ useAgentStore: agentStore }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  window.api = {
    agentChat: {
      init: vi.fn(async () => ({ success: true }))
    }
  } as never
  agentStore.getState.mockReturnValue({
    setReady: agentStore.setReady,
    setConfigured: agentStore.setConfigured
  })
})

describe('applyServerModelConfigAndStart', () => {
  it('本地 Ollama 开启时优先装配本地 OpenAI 兼容端点', async () => {
    storage.get.mockResolvedValueOnce({
      enabled: true,
      baseUrl: 'http://127.0.0.1:11434/',
      modelName: 'qwen'
    })
    const { applyServerModelConfigAndStart } = await import('../model-bootstrap')

    await expect(applyServerModelConfigAndStart()).resolves.toEqual({
      ok: true,
      configured: true,
      retryable: false
    })
    expect(window.api.agentChat.init).toHaveBeenCalledWith({
      providerId: 'openai',
      model: 'qwen',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKeyStoreKey: 'ollama-api-key'
    })
    expect(server.fetchModelConfig).not.toHaveBeenCalled()
    expect(agentStore.setReady).toHaveBeenCalledWith(true)
    expect(agentStore.setConfigured).toHaveBeenCalledWith(true)
  })

  it('没有本地模型时使用服务器模型配置装配 runtime', async () => {
    storage.get.mockResolvedValueOnce(null)
    server.fetchModelConfig.mockResolvedValueOnce({
      baseUrl: 'https://api.example.com/v1',
      modelName: 'gpt-4o',
      allowLocalOverride: false,
      hasCredential: true
    })
    const { applyServerModelConfigAndStart } = await import('../model-bootstrap')

    await expect(applyServerModelConfigAndStart()).resolves.toEqual({
      ok: true,
      configured: true,
      retryable: false
    })
    expect(window.api.agentChat.init).toHaveBeenCalledWith({
      providerId: 'openai',
      model: 'gpt-4o',
      baseUrl: 'https://api.example.com/v1',
      apiKeyStoreKey: 'openai-api-key'
    })
    expect(agentStore.setReady).toHaveBeenCalledWith(true)
    expect(agentStore.setConfigured).toHaveBeenCalledWith(true)
  })

  it('服务器未配置模型时降级为可用但未装配(终态,不重试)', async () => {
    storage.get.mockResolvedValueOnce(null)
    server.fetchModelConfig.mockResolvedValueOnce({
      baseUrl: '',
      modelName: '',
      allowLocalOverride: false,
      hasCredential: false
    })
    const { applyServerModelConfigAndStart } = await import('../model-bootstrap')

    await expect(applyServerModelConfigAndStart()).resolves.toEqual({
      ok: true,
      configured: false,
      retryable: false
    })
    expect(window.api.agentChat.init).not.toHaveBeenCalled()
    expect(agentStore.setReady).toHaveBeenCalledWith(true)
    expect(agentStore.setConfigured).not.toHaveBeenCalled()
  })

  it('拉取服务器配置失败(网络/超时)时降级为可用、标记可重试', async () => {
    storage.get.mockResolvedValueOnce(null)
    server.fetchModelConfig.mockRejectedValueOnce(new Error('fetch failed'))
    const { applyServerModelConfigAndStart } = await import('../model-bootstrap')

    await expect(applyServerModelConfigAndStart()).resolves.toEqual({
      ok: true,
      configured: false,
      retryable: true
    })
    expect(window.api.agentChat.init).not.toHaveBeenCalled()
    expect(agentStore.setReady).toHaveBeenCalledWith(true)
    expect(agentStore.setConfigured).not.toHaveBeenCalled()
  })

  it('装配异常时记录错误并返回可重试', async () => {
    storage.get.mockRejectedValueOnce(new Error('storage down'))
    const { applyServerModelConfigAndStart } = await import('../model-bootstrap')

    await expect(applyServerModelConfigAndStart()).resolves.toEqual({
      ok: false,
      configured: false,
      retryable: true,
      error: 'storage down'
    })
    expect(logger.error).toHaveBeenCalledWith('[model-bootstrap] 装配失败:', 'storage down')
  })
})
