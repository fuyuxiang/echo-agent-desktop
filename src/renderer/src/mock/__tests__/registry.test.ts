import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiUrls, ServerApiUrls } from '@/request/urls'

beforeEach(() => {
  vi.resetModules()
})

describe('mock registry', () => {
  it('registerMock/resolveMock 按 METHOD + URL 精确匹配', async () => {
    const { registerMock, resolveMock } = await import('../registry')
    const handler = (params: Record<string, unknown>): unknown => ({ params })
    registerMock('get', '/api/x', handler)

    expect(resolveMock('GET', '/api/x')).toBe(handler)
    expect(resolveMock('POST', '/api/x')).toBeUndefined()
  })

  it('mock index 注册示例、服务端和项目记忆 mock', async () => {
    const { resolveMock } = await import('../index')

    expect(resolveMock('GET', ApiUrls.example.greeting)?.({})).toMatchObject({
      message: expect.stringContaining('Mock')
    })
    expect(resolveMock('GET', ApiUrls.example.list)?.({ keyword: 'IPC' })).toEqual([
      expect.objectContaining({ title: expect.stringContaining('IPC') })
    ])
    expect(resolveMock('POST', ServerApiUrls.login)?.({})).toMatchObject({
      token: 'mock-token'
    })
    expect(resolveMock('GET', ServerApiUrls.projectMemory)?.({})).toEqual([
      expect.objectContaining({ content: '部署用内部 k8s 集群' })
    ])
  })
})
