// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeApi } from '@shared/types/api'
import type { MemoryEntry } from '../memory'

function entry(patch: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 1,
    content: '记住用户喜欢 TypeScript',
    memType: 'user',
    tier: 'semantic',
    keywords: ['TypeScript'],
    tags: ['preference'],
    contextDesc: 'chat',
    importance: 0.8,
    confidence: 0.9,
    salience: null,
    provenance: null,
    accessCount: 0,
    lastAccess: null,
    createdAt: 10,
    updatedAt: 20,
    supersededBy: null,
    ...patch
  }
}

function installApi(): BridgeApi {
  const api = {
    store: {
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      secureGet: vi.fn(async () => undefined),
      secureSet: vi.fn(async () => undefined),
      secureDelete: vi.fn(async () => undefined)
    },
    system: {
      httpProxy: vi.fn(async () => ({ ok: true, status: 200, body: '{}' })),
      notify: vi.fn(),
      clipboardReadText: vi.fn(),
      clipboardWriteText: vi.fn(),
      openExternal: vi.fn(),
      showItemInFolder: vi.fn(),
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn()
    },
    agentChat: {
      deleteSession: vi.fn(async () => ({ success: true })),
      send: vi.fn(),
      abort: vi.fn(),
      listSessions: vi.fn(),
      init: vi.fn(),
      onEvent: vi.fn()
    },
    agentMemory: {
      list: vi.fn(async () => []),
      search: vi.fn(async () => []),
      get: vi.fn(async () => null),
      update: vi.fn(async () => ({ success: true })),
      delete: vi.fn(async () => ({ success: true })),
      stats: vi.fn(async () => ({
        total: 1,
        byTier: { semantic: 1, procedural: 0, archival: 0 },
        byType: { user: 1, environment: 0, procedural: 0 },
        avgConfidence: 0.9,
        linkCount: 0,
        episodeCount: 0,
        unconsolidatedCount: 0
      }))
    },
    agentSkill: {
      list: vi.fn(async () => [{ id: 'ppt', label: 'PPT', description: 'd', kind: 'code' }]),
      active: vi.fn(async () => ['ppt']),
      activate: vi.fn(async () => ({ success: true })),
      deactivate: vi.fn(async () => ({ success: true }))
    },
    echoAgent: {
      getEndpoint: vi.fn(async () => ({ baseUrl: 'https://agent.local', apiPrefix: '/api/v1', wsPath: '/ws' }))
    }
  } as unknown as BridgeApi
  window.api = api
  return api
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  installApi()
  vi.stubGlobal('fetch', vi.fn())
})

describe('agent service facades', () => {
  it('memoryAPI 走 agentMemory IPC 并在前端过滤 type/tier', async () => {
    const first = entry()
    const second = entry({ id: 2, memType: 'environment', tier: 'archival', content: 'env' })
    vi.mocked(window.api.agentMemory.list).mockResolvedValueOnce([first, second] as unknown as Record<string, unknown>[])
    vi.mocked(window.api.agentMemory.search).mockResolvedValueOnce([
      { ...first, score: 0.75 }
    ] as unknown as Record<string, unknown>[])
    vi.mocked(window.api.agentMemory.get).mockResolvedValueOnce({ record: first as unknown as Record<string, unknown>, provenance: null })

    const { memoryAPI } = await import('../memory')

    await expect(memoryAPI.list({ type: 'user', tier: 'semantic', limit: 5, offset: 2 })).resolves.toEqual({
      entries: [first],
      total: 1
    })
    expect(window.api.agentMemory.list).toHaveBeenCalledWith({ limit: 5, offset: 2 })

    const search = await memoryAPI.search('typescript', { limit: 3 })
    expect(search.results[0].score).toBe(0.75)
    expect(search.results[0].entry).toMatchObject(first)
    expect(window.api.agentMemory.search).toHaveBeenCalledWith({ query: 'typescript', topK: 3 })

    await expect(memoryAPI.get('1')).resolves.toEqual(first)
    await memoryAPI.update('1', { content: 'new' })
    await memoryAPI.delete('1')
    await expect(memoryAPI.stats()).resolves.toMatchObject({ total: 1 })
    expect(window.api.agentMemory.update).toHaveBeenCalledWith(1, { content: 'new' })
    expect(window.api.agentMemory.delete).toHaveBeenCalledWith(1)
  })

  it('skillsAPI/chatAPI 和下线 stub 返回当前 P6 行为', async () => {
    const [{ skillsAPI }, { chatAPI }, { channelsAPI }, { configAPI }, { knowledgeAPI }, index] =
      await Promise.all([
        import('../skills'),
        import('../chat'),
        import('../channels'),
        import('../config'),
        import('../knowledge'),
        import('../index')
      ])

    await expect(skillsAPI.list()).resolves.toEqual({
      skills: [{ id: 'ppt', label: 'PPT', description: 'd', kind: 'code' }]
    })
    await expect(skillsAPI.get('ppt')).resolves.toEqual({ content: '', files: [] })
    await expect(skillsAPI.activate('c1', 'ppt')).resolves.toEqual({ success: true })
    await expect(skillsAPI.deactivate('c1', 'ppt')).resolves.toEqual({ success: true })
    await expect(skillsAPI.importFromPath('/tmp/skill')).resolves.toMatchObject({ success: false })
    await expect(skillsAPI.remove('ppt')).resolves.toMatchObject({ success: false })
    expect(window.api.agentSkill.activate).toHaveBeenCalledWith('c1', 'ppt')

    await expect(chatAPI.list()).resolves.toEqual({ sessions: [] })
    await expect(chatAPI.delete('c1')).resolves.toEqual({ success: true })
    expect(window.api.agentChat.deleteSession).toHaveBeenCalledWith('c1')

    await expect(channelsAPI.list()).rejects.toThrow('channels.list 暂未提供')
    await expect(configAPI.get()).rejects.toThrow('config.get 暂未提供')
    await expect(configAPI.getModels()).rejects.toThrow('config.getModels 暂未提供')
    await expect(knowledgeAPI.getStatus()).rejects.toThrow('knowledge.getStatus 暂未提供')
    await expect(knowledgeAPI.rebuild()).rejects.toThrow('knowledge.rebuild 暂未提供')
    await expect(knowledgeAPI.listDocuments()).rejects.toThrow('knowledge.listDocuments 暂未提供')
    expect(index.skillsAPI).toBe(skillsAPI)
    expect(index.chatAPI).toBe(chatAPI)
  })

  it('agentRequest 经主进程 httpProxy 注入远端 token、解析 JSON 并处理错误', async () => {
    const { useAgentStore } = await import('@/stores/agentStore')
    useAgentStore.setState({ remoteToken: 'token-1' })
    vi.mocked(window.api.system.httpProxy).mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: '{"ok":true}'
    })
    const { agentRequest } = await import('../proxy-request')

    await expect(agentRequest.get<{ ok: boolean }>('https://agent/api')).resolves.toEqual({
      data: { ok: true }
    })
    expect(window.api.system.httpProxy).toHaveBeenCalledWith({
      url: 'https://agent/api',
      method: 'GET',
      headers: { 'X-Echo-Agent-Token': 'token-1' },
      body: undefined
    })

    vi.mocked(window.api.system.httpProxy).mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: 'plain text'
    })
    await expect(agentRequest.post<string>('https://agent/post', { a: 1 })).resolves.toEqual({
      data: 'plain text'
    })
    expect(window.api.system.httpProxy).toHaveBeenLastCalledWith({
      url: 'https://agent/post',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Echo-Agent-Token': 'token-1' },
      body: '{"a":1}'
    })

    vi.mocked(window.api.system.httpProxy).mockResolvedValueOnce({
      ok: false,
      status: 500,
      body: 'err'
    })
    await expect(agentRequest.delete('https://agent/delete')).rejects.toThrow('HTTP 500')
  })

  it('attachmentsAPI 使用 agentStore baseUrl/remoteToken 上传附件', async () => {
    const { useAgentStore } = await import('@/stores/agentStore')
    useAgentStore.setState({ baseUrl: 'https://agent.local', remoteToken: 'token-1' })
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'att-1', name: 'a.txt', mime_type: 'text/plain', size: 1 }), {
        status: 200
      })
    )
    const { attachmentsAPI } = await import('../attachments')

    await expect(attachmentsAPI.upload(new File(['x'], 'a.txt', { type: 'text/plain' }))).resolves.toEqual({
      id: 'att-1',
      name: 'a.txt',
      mime_type: 'text/plain',
      size: 1
    })
    expect(fetch).toHaveBeenCalledWith('https://agent.local/api/v1/chat/attachments', {
      method: 'POST',
      headers: { 'X-Echo-Agent-Token': 'token-1' },
      body: expect.any(FormData)
    })

    vi.mocked(fetch).mockResolvedValueOnce(new Response('fail', { status: 500 }))
    await expect(attachmentsAPI.upload(new File(['x'], 'a.txt'))).rejects.toThrow('附件上传失败 HTTP 500')
  })

  it('agent-memory 对外模型保持 string id 并复用 memoryAPI', async () => {
    const first = entry()
    vi.mocked(window.api.agentMemory.list).mockResolvedValueOnce([first] as unknown as Record<string, unknown>[])
    vi.mocked(window.api.agentMemory.search).mockResolvedValueOnce([
      { ...first, score: 0.9 }
    ] as unknown as Record<string, unknown>[])
    const { toPersonalMemory, listPersonalMemory, searchPersonalMemory, deletePersonalMemory } =
      await import('../../agent-memory')

    expect(toPersonalMemory(first)).toMatchObject({ id: '1', content: first.content })
    await expect(listPersonalMemory()).resolves.toMatchObject([{ id: '1' }])
    await expect(searchPersonalMemory('ts')).resolves.toMatchObject([{ id: '1' }])
    await deletePersonalMemory('1')
    expect(window.api.agentMemory.delete).toHaveBeenCalledWith(1)
  })

  it('Ollama 客户端通过 httpProxy 探测、列模型和拉取', async () => {
    const { detectOllama, listOllamaModels, pullOllamaModel, DEFAULT_OLLAMA_BASE_URL } =
      await import('../../ollama')

    vi.mocked(window.api.system.httpProxy).mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: '{"version":"0.1.0"}'
    })
    await expect(detectOllama('http://localhost:11434/')).resolves.toEqual({
      online: true,
      version: '0.1.0'
    })
    expect(window.api.system.httpProxy).toHaveBeenCalledWith({
      url: 'http://localhost:11434/api/version',
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: undefined
    })

    vi.mocked(window.api.system.httpProxy).mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: '{"models":[{"name":"qwen"},{"name":"llama"}]}'
    })
    await expect(listOllamaModels('')).resolves.toEqual(['qwen', 'llama'])
    expect(window.api.system.httpProxy).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: `${DEFAULT_OLLAMA_BASE_URL}/api/tags` })
    )

    vi.mocked(window.api.system.httpProxy).mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: '{"status":"success"}'
    })
    await expect(pullOllamaModel('http://localhost:11434', 'qwen')).resolves.toBeUndefined()

    vi.mocked(window.api.system.httpProxy).mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: '{"error":"no space"}'
    })
    await expect(pullOllamaModel('http://localhost:11434', 'qwen')).rejects.toThrow('no space')
  })
})
