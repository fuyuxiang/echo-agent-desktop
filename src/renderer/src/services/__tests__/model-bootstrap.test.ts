// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => ({ get: vi.fn() }))
const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
const agent = vi.hoisted(() => ({
  setReady: vi.fn(),
  setConfigured: vi.fn(),
  getState: vi.fn()
}))

vi.mock('@/utils', () => ({ storage }))
vi.mock('@/utils/logger', () => ({ logger }))
vi.mock('@/stores/agentStore', () => ({ useAgentStore: agent }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  agent.getState.mockReturnValue({ setReady: agent.setReady, setConfigured: agent.setConfigured })
  window.api = {
    org: {
      status: vi.fn(async () => ({ loggedIn: false })),
      modelConfig: vi.fn()
    },
    echoConfig: { apply: vi.fn(async () => undefined) }
  } as never
})

describe('applyServerModelConfigAndStart', () => {
  it('本地 Ollama 优先，并显式标记 source', async () => {
    storage.get.mockResolvedValueOnce({
      enabled: true,
      baseUrl: 'http://127.0.0.1:11434/',
      modelName: 'qwen'
    })
    const { applyServerModelConfigAndStart } = await import('../model-bootstrap')

    await expect(applyServerModelConfigAndStart()).resolves.toMatchObject({ ok: true, configured: true })
    expect(window.api.echoConfig.apply).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: 'ollama',
      model: 'qwen',
      source: 'ollama'
    })
  })

  it('企业模型只传脱敏元数据，不传服务端密钥', async () => {
    storage.get.mockResolvedValueOnce(null)
    vi.mocked(window.api.org.status).mockResolvedValueOnce({ loggedIn: true } as never)
    vi.mocked(window.api.org.modelConfig).mockResolvedValueOnce({
      configured: true,
      chatProvider: 'openai',
      chatModel: 'gpt-4o',
      hasCredential: true,
      proxied: true
    })
    const { applyServerModelConfigAndStart } = await import('../model-bootstrap')

    await expect(applyServerModelConfigAndStart()).resolves.toMatchObject({ ok: true, configured: true })
    expect(window.api.echoConfig.apply).toHaveBeenCalledWith({
      baseUrl: '', apiKey: '', model: 'gpt-4o', source: 'enterprise'
    })
  })

  it('本地手工模型只将 safeStorage 引用交给主进程', async () => {
    storage.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        baseUrl: 'https://api.example.com/v1', modelName: 'gpt-4o', apiKeyRef: 'openai-api-key'
      })
    const { applyServerModelConfigAndStart } = await import('../model-bootstrap')

    await expect(applyServerModelConfigAndStart()).resolves.toMatchObject({ ok: true, configured: true })
    expect(window.api.echoConfig.apply).toHaveBeenCalledWith({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'ref:openai-api-key',
      model: 'gpt-4o',
      source: 'local'
    })
  })

  it('已登录但服务器不可达且无本地兜底时可重试', async () => {
    storage.get.mockResolvedValue(null)
    vi.mocked(window.api.org.status).mockResolvedValueOnce({ loggedIn: true } as never)
    vi.mocked(window.api.org.modelConfig).mockRejectedValueOnce(new Error('offline'))
    const { applyServerModelConfigAndStart } = await import('../model-bootstrap')

    await expect(applyServerModelConfigAndStart()).resolves.toEqual({
      ok: true, configured: false, retryable: true
    })
    expect(window.api.echoConfig.apply).not.toHaveBeenCalled()
  })
})
