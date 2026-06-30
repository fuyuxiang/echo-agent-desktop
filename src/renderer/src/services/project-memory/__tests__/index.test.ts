import { describe, it, expect, vi, beforeEach } from 'vitest'

const search = vi.fn()
vi.mock('@/services/server', () => ({
  searchProjectMemory: (...a: unknown[]) => search(...a),
  listProjectMemory: vi.fn(async () => []),
  writeProjectMemory: vi.fn(async () => ({}))
}))

import { retrieveForMessage } from '../index'

describe('retrieveForMessage', () => {
  beforeEach(() => vi.clearAllMocks())
  it('injects project memory context when hits found', async () => {
    search.mockResolvedValue([
      { id: '1', groupId: 'g', content: '蓝绿部署', tags: [], sourceUser: 'u', createdAt: 0, updatedAt: 0 }
    ])
    const out = await retrieveForMessage('帮我部署')
    expect(out).toContain('蓝绿部署')
    expect(out.endsWith('帮我部署')).toBe(true)
  })
  it('returns user text unchanged on no hits', async () => {
    search.mockResolvedValue([])
    expect(await retrieveForMessage('hello')).toBe('hello')
  })
  it('returns user text unchanged on search error (best-effort)', async () => {
    search.mockRejectedValue(new Error('net'))
    expect(await retrieveForMessage('hello')).toBe('hello')
  })
})
