// src/main/agent/tools/__tests__/web.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import type { ToolContext } from '../base'

// electron-store 依赖 electron app.*, node 环境需 mock 掉
vi.mock('electron', () => ({
  app: {
    getPath: () => os.tmpdir(),
    getAppPath: () => os.tmpdir(),
    isPackaged: false
  },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const kvRef: { current: Map<string, unknown> } = { current: new Map() }
vi.mock('electron-store', () => ({
  default: class FakeStore {
    get(k: string): unknown {
      return kvRef.current.get(k)
    }
    set(k: string, v: unknown): void {
      kvRef.current.set(k, v)
    }
    delete(k: string): void {
      kvRef.current.delete(k)
    }
    clear(): void {
      kvRef.current.clear()
    }
  }
}))

const ctx = (): ToolContext => ({
  chatId: 'c1',
  workspace: '/tmp',
  signal: new AbortController().signal,
  onProgress: () => {}
})

beforeEach(() => {
  kvRef.current = new Map()
  vi.resetModules()
})
afterEach(() => vi.unstubAllGlobals())

describe('web tools', () => {
  it('web_fetch 抓取并剥标签', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html><body><p>Hello <b>World</b></p></body></html>', { status: 200 }))
    )
    const { webFetchTool } = await import('../web')
    const r = await webFetchTool.execute({ url: 'https://e.com' }, ctx())
    expect(r.ok).toBe(true)
    expect(r.content).toContain('Hello')
    expect(r.content).not.toContain('<b>')
  })
  it('web_fetch 非 2xx 返回 ok:false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    const { webFetchTool } = await import('../web')
    expect((await webFetchTool.execute({ url: 'https://e.com' }, ctx())).ok).toBe(false)
  })
  it('web_search 解析结果数组', async () => {
    kvRef.current.set('agent.searchEndpoint', 'https://search.example.com/q')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ results: [{ title: 'T', url: 'u', snippet: 'S' }] }), {
          status: 200
        })
      )
    )
    const { webSearchTool } = await import('../web')
    const r = await webSearchTool.execute({ query: 'x' }, ctx())
    expect(r.ok).toBe(true)
    expect(r.content).toContain('T')
    expect(r.content).toContain('u')
  })
  it('web_search 未配置端点时返回 ok:false', async () => {
    const { webSearchTool } = await import('../web')
    expect((await webSearchTool.execute({ query: 'x' }, ctx())).ok).toBe(false)
  })
  it('web_fetch 拒绝内网地址(SSRF 防护)', async () => {
    const { webFetchTool } = await import('../web')
    expect((await webFetchTool.execute({ url: 'http://169.254.169.254/latest/meta-data/' }, ctx())).ok).toBe(false)
    expect((await webFetchTool.execute({ url: 'http://127.0.0.1:8080/' }, ctx())).ok).toBe(false)
    expect((await webFetchTool.execute({ url: 'file:///etc/passwd' }, ctx())).ok).toBe(false)
  })
})
