import { describe, it, expect } from 'vitest'
import { upsertMirror, listMirror, deleteMirrorByServerId, type DbLike } from '../project-memory'

function fakeDb(rows: Record<string, unknown>[] = []): { db: DbLike; calls: { sql: string; args: unknown[] }[] } {
  const calls: { sql: string; args: unknown[] }[] = []
  const db: DbLike = {
    prepare: (sql: string) => ({
      run: (...args: unknown[]) => { calls.push({ sql, args }); return undefined },
      get: (...args: unknown[]) => { calls.push({ sql, args }); return undefined },
      all: (...args: unknown[]) => { calls.push({ sql, args }); return rows }
    })
  }
  return { db, calls }
}

describe('project-memory DAO', () => {
  it('upsertMirror runs an UPSERT with serialized tags', () => {
    const { db, calls } = fakeDb()
    upsertMirror(db, { serverId: 's1', content: 'c', tags: ['a', 'b'], version: 5, updatedAt: 5 })
    expect(calls[0].sql).toMatch(/INSERT INTO project_memory_mirror/i)
    expect(calls[0].sql).toMatch(/ON CONFLICT/i)
    expect(calls[0].args).toContain('s1')
    expect(calls[0].args).toContain(JSON.stringify(['a', 'b']))
  })
  it('listMirror parses tags JSON back to array', () => {
    const { db } = fakeDb([{ server_id: 's1', content: 'c', tags: '["a"]', version: 5, updated_at: 5 }])
    expect(listMirror(db)).toEqual([
      { serverId: 's1', content: 'c', tags: ['a'], version: 5, updatedAt: 5 }
    ])
  })
  it('deleteMirrorByServerId runs DELETE with serverId', () => {
    const { db, calls } = fakeDb()
    deleteMirrorByServerId(db, 's1')
    expect(calls[0].sql).toMatch(/DELETE FROM project_memory_mirror/i)
    expect(calls[0].args).toEqual(['s1'])
  })
})
