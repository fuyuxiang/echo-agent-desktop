import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../db/migrations'
import { MemoryDao } from '../dao'
import { Metacognition } from '../metacognition'

let db: Database.Database
let dao: MemoryDao
let meta: Metacognition
beforeEach(() => {
  db = new Database(':memory:')
  runMigrations(db)
  dao = new MemoryDao(db)
  meta = new Metacognition({ db, dao })
})

describe('Metacognition.provenanceOf', () => {
  it('返回记忆的 provenance', () => {
    const m = dao.insertMemory({
      content: 'x', memType: 'user', tier: 'semantic', importance: 5,
      provenance: { sessionKey: 'c1', messageIds: [3, 4] }
    })
    expect(meta.provenanceOf(m.id)).toEqual({ sessionKey: 'c1', messageIds: [3, 4] })
  })
  it('无 provenance 返回 null', () => {
    const m = dao.insertMemory({ content: 'y', memType: 'user', tier: 'semantic', importance: 5 })
    expect(meta.provenanceOf(m.id)).toBeNull()
  })
  it('不存在的 id 返回 null', () => {
    expect(meta.provenanceOf(999)).toBeNull()
  })
})

describe('Metacognition.stats', () => {
  it('聚合有效记忆的分层/类型/置信度/链接/情景计数', () => {
    dao.insertMemory({ content: 'a', memType: 'user', tier: 'semantic', importance: 5, confidence: 0.8 })
    const b = dao.insertMemory({ content: 'b', memType: 'environment', tier: 'archival', importance: 5, confidence: 0.6 })
    const c = dao.insertMemory({ content: 'c', memType: 'user', tier: 'semantic', importance: 5, confidence: 0.7 })
    dao.softDelete(b.id) // 失效,不计入
    dao.addLink({ fromId: c.id, toId: 1, relation: 'related', weight: 0.5 })
    dao.insertEpisode({ content: 'ep1', sessionKey: 'c1' })
    const s = meta.stats()
    expect(s.total).toBe(2) // a + c (b 已失效)
    expect(s.byTier.semantic).toBe(2)
    expect(s.byType.user).toBe(2)
    expect(s.avgConfidence).toBeCloseTo(0.75)
    expect(s.linkCount).toBe(1)
    expect(s.episodeCount).toBe(1)
    expect(s.unconsolidatedCount).toBe(1)
  })
})
