import { describe, expect, it, vi } from 'vitest'
import { OrgClient } from '../client'

function makeClient(data: unknown = {}) {
  const fetchFn = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify({ code: 0, msg: 'ok', data }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }))
  const client = new OrgClient({
    getServerUrl: () => 'https://org.example',
    getTokens: async () => ({ accessToken: 'access', refreshToken: 'refresh' }),
    saveTokens: async () => {},
    clearTokens: async () => {},
    fetchFn: fetchFn as unknown as typeof fetch
  })
  return { client, fetchFn }
}

describe('OrgClient server wire contract', () => {
  it('uses camelCase scopeId and deviceId query parameters', async () => {
    const { client, fetchFn } = makeClient({
      items: [], total: 0, page: 1, size: 20,
      nextCursor: 1, docs: [], memories: [], revokedDocs: [], revokedMemories: [],
      purgeAll: false, hasMore: false
    })
    await client.listDocs({ scope_id: 'scope-1' })
    expect(String(fetchFn.mock.calls[0][0])).toContain('scopeId=scope-1')
    await client.sync(0, 'device-1')
    expect(String(fetchFn.mock.calls[1][0])).toContain('deviceId=device-1')
  })

  it('translates Desktop QA fields to the server camelCase schema', async () => {
    const { client, fetchFn } = makeClient({ id: 'qa-1' })
    await client.qaEvent({
      question: '问题', answered: true, cited_chunks: ['c1'],
      top_score: 0.9, latency_ms: 120, route: 'fast'
    })
    const body = JSON.parse(String(fetchFn.mock.calls[0][1]?.body))
    expect(body).toMatchObject({
      citedChunks: ['c1'], topScore: 0.9, latencyMs: 120
    })
    expect(body.cited_chunks).toBeUndefined()
  })

  it('reads the raw public health response instead of requiring an API envelope', async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    ) as unknown as typeof fetch
    const client = new OrgClient({
      getServerUrl: () => 'https://org.example',
      getTokens: async () => null,
      saveTokens: async () => {},
      clearTokens: async () => {},
      fetchFn
    })
    await expect(client.health()).resolves.toEqual({ ok: true })
  })
})
