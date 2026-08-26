// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const managementRequest = vi.fn()
const ollamaRequest = vi.fn()

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  window.api = {
    echoAgent: { managementRequest },
    system: { ollamaRequest }
  } as never
})

describe('Agent management facades', () => {
  it('记忆列表/搜索/删除统一走主进程白名单桥', async () => {
    managementRequest
      .mockResolvedValueOnce({
        entries: [{
          id: 'm1', content: 'TypeScript', type: 'user', tier: 'semantic', tags: ['pref'],
          created_at: '2026-08-26T00:00:00Z', updated_at: '2026-08-26T01:00:00Z'
        }],
        total: 1
      })
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ status: 'deleted' })
    const { memoryAPI } = await import('../memory')

    await expect(memoryAPI.list()).resolves.toMatchObject({
      total: 1,
      entries: [{ id: 'm1', content: 'TypeScript', tags: ['pref'] }]
    })
    await memoryAPI.search('typescript')
    await memoryAPI.delete('m1')
    expect(managementRequest).toHaveBeenNthCalledWith(2, {
      method: 'POST', path: '/memory/search', body: { query: 'typescript', limit: 8, all_scopes: true }
    })
    expect(managementRequest).toHaveBeenNthCalledWith(3, {
      method: 'DELETE', path: '/memory/m1?override=true'
    })
  })

  it('附件上传传递字节而不在渲染层直连 Agent', async () => {
    managementRequest.mockResolvedValueOnce({ id: 'a1', name: 'a.txt', mime_type: 'text/plain', size: 1 })
    const { attachmentsAPI } = await import('../attachments')
    const file = {
      name: 'a.txt', type: 'text/plain', arrayBuffer: async () => new Uint8Array([120]).buffer
    } as File

    await expect(attachmentsAPI.upload(file)).resolves.toMatchObject({ id: 'a1' })
    expect(managementRequest).toHaveBeenCalledWith({
      method: 'POST', path: '/chat/attachments',
      file: { name: 'a.txt', mimeType: 'text/plain', data: new Uint8Array([120]) }
    })
  })

  it('Ollama 只调用受限桥的固定端点', async () => {
    ollamaRequest
      .mockResolvedValueOnce({ ok: true, status: 200, body: '{"version":"1.0"}' })
      .mockResolvedValueOnce({ ok: true, status: 200, body: '{"models":[{"name":"qwen"}]}' })
    const { detectOllama, listOllamaModels } = await import('../../ollama')

    await expect(detectOllama('http://localhost:11434')).resolves.toMatchObject({ online: true, version: '1.0' })
    await expect(listOllamaModels('http://localhost:11434')).resolves.toEqual(['qwen'])
    expect(ollamaRequest).toHaveBeenNthCalledWith(1, {
      baseUrl: 'http://localhost:11434', path: '/api/version', method: undefined, body: undefined
    })
    expect(ollamaRequest).toHaveBeenNthCalledWith(2, {
      baseUrl: 'http://localhost:11434', path: '/api/tags', method: undefined, body: undefined
    })
  })
})
