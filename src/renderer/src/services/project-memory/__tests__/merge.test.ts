import { describe, it, expect } from 'vitest'
import { mergeProjectMemory, type MirrorRow } from '../merge'
import type { ProjectMemory } from '@/services/server'

function sm(id: string, content: string, updatedAt: number): ProjectMemory {
  return { id, groupId: 'g', content, tags: ['t'], sourceUser: 'u', createdAt: 0, updatedAt }
}
function lm(serverId: string, content: string, updatedAt: number): MirrorRow {
  return { serverId, content, tags: ['t'], version: updatedAt, updatedAt }
}

describe('mergeProjectMemory', () => {
  it('upserts new server entries not in local', () => {
    const r = mergeProjectMemory([], [sm('s1', 'a', 100)])
    expect(r.upserts).toEqual([{ serverId: 's1', content: 'a', tags: ['t'], version: 100, updatedAt: 100 }])
    expect(r.deletes).toEqual([])
  })
  it('server wins when updatedAt newer', () => {
    const r = mergeProjectMemory([lm('s1', 'old', 100)], [sm('s1', 'new', 200)])
    expect(r.upserts).toEqual([{ serverId: 's1', content: 'new', tags: ['t'], version: 200, updatedAt: 200 }])
  })
  it('skips identical updatedAt (idempotent, no churn)', () => {
    const r = mergeProjectMemory([lm('s1', 'x', 100)], [sm('s1', 'x', 100)])
    expect(r.upserts).toEqual([])
    expect(r.deletes).toEqual([])
  })
  it('deletes local rows absent from server', () => {
    const r = mergeProjectMemory([lm('s1', 'x', 100)], [])
    expect(r.deletes).toEqual(['s1'])
    expect(r.upserts).toEqual([])
  })
})
