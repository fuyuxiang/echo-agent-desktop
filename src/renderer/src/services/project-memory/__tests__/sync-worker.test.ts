import { describe, it, expect, vi } from 'vitest'
import { tickUpload, tickDownload, type SyncDeps } from '../sync-worker'
import type { ProjectMemory } from '@/services/server'

function baseDeps(over: Partial<SyncDeps> = {}): SyncDeps {
  const sharedSet = new Set<string>()
  return {
    listCognitiveMemory: async () => [],
    listServerProjectMemory: async () => [],
    writeServerProjectMemory: vi.fn(async () => ({})),
    listMirror: async () => [],
    upsertMirror: vi.fn(async () => {}),
    deleteMirror: vi.fn(async () => {}),
    alreadyShared: (c) => sharedSet.has(c),
    markShared: (c) => sharedSet.add(c),
    ...over
  }
}
function sm(id: string, content: string, updatedAt: number): ProjectMemory {
  return { id, groupId: 'g', content, tags: ['t'], sourceUser: 'u', createdAt: 0, updatedAt }
}

describe('tickUpload', () => {
  it('uploads shareable memories not already shared, marks them', async () => {
    const write = vi.fn(async () => ({}))
    const deps = baseDeps({
      listCognitiveMemory: async () => [
        { id: '1', content: '部署规范', tags: ['project'], importance: 0.5 },
        { id: '2', content: '口味', tags: ['personal'], importance: 0.5 }
      ],
      writeServerProjectMemory: write
    })
    const n = await tickUpload(deps)
    expect(n).toBe(1)
    expect(write).toHaveBeenCalledWith('部署规范', ['project'])
  })
  it('skips already-shared content (idempotent)', async () => {
    const write = vi.fn(async () => ({}))
    const deps = baseDeps({
      listCognitiveMemory: async () => [{ id: '1', content: 'X', tags: ['project'], importance: 0.5 }],
      writeServerProjectMemory: write,
      alreadyShared: () => true
    })
    expect(await tickUpload(deps)).toBe(0)
    expect(write).not.toHaveBeenCalled()
  })
})

describe('tickDownload', () => {
  it('applies merge upserts and deletes to mirror', async () => {
    const upsert = vi.fn(async () => {})
    const del = vi.fn(async () => {})
    const deps = baseDeps({
      listServerProjectMemory: async () => [sm('s1', 'new', 200)],
      listMirror: async () => [
        { serverId: 's1', content: 'old', tags: ['t'], version: 100, updatedAt: 100 },
        { serverId: 's2', content: 'gone', tags: ['t'], version: 50, updatedAt: 50 }
      ],
      upsertMirror: upsert,
      deleteMirror: del
    })
    const r = await tickDownload(deps)
    expect(r).toEqual({ upserted: 1, deleted: 1 })
    expect(upsert).toHaveBeenCalledWith({ serverId: 's1', content: 'new', tags: ['t'], version: 200, updatedAt: 200 })
    expect(del).toHaveBeenCalledWith('s2')
  })
})
