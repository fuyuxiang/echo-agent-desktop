import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  listPersonalMemory,
  searchPersonalMemory,
  deletePersonalMemory
} from '../agent-memory'
import { memoryAPI } from '../agent/memory'

vi.mock('../agent/memory', () => ({
  memoryAPI: {
    list: vi.fn(),
    search: vi.fn(),
    delete: vi.fn()
  }
}))

const sampleEntry = {
  id: 'p1',
  type: 'user',
  tier: 'semantic',
  key: 'k',
  content: 'c',
  tags: ['t1'],
  importance: 0.5,
  source_session: 's1',
  access_count: 3,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z'
}

describe('agent memory service', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lists personal memory, unwrapping entries and mapping to camelCase', async () => {
    ;(memoryAPI.list as any).mockResolvedValue({ entries: [sampleEntry], total: 1 })

    const res = await listPersonalMemory()

    expect(memoryAPI.list).toHaveBeenCalledOnce()
    expect(res).toHaveLength(1)
    expect(res[0]).toEqual({
      id: 'p1',
      type: 'user',
      tier: 'semantic',
      key: 'k',
      content: 'c',
      tags: ['t1'],
      importance: 0.5,
      sourceSession: 's1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z'
    })
  })

  it('searches personal memory, unwrapping results[].entry', async () => {
    ;(memoryAPI.search as any).mockResolvedValue({
      results: [{ entry: sampleEntry, score: 0.9 }]
    })

    const res = await searchPersonalMemory('部署')

    expect(memoryAPI.search).toHaveBeenCalledWith('部署')
    expect(res).toHaveLength(1)
    expect(res[0].id).toBe('p1')
    expect(res[0].sourceSession).toBe('s1')
  })

  it('deletes personal memory by id and resolves to void', async () => {
    ;(memoryAPI.delete as any).mockResolvedValue({ status: 'deleted' })

    const res = await deletePersonalMemory('p1')

    expect(memoryAPI.delete).toHaveBeenCalledWith('p1')
    expect(res).toBeUndefined()
  })
})
