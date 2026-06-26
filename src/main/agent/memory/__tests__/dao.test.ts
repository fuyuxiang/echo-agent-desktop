// src/main/agent/memory/__tests__/dao.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../db/migrations'
import { MemoryDao } from '../dao'

let db: Database.Database
let dao: MemoryDao
beforeEach(() => {
  db = new Database(':memory:')
  runMigrations(db)
  dao = new MemoryDao(db)
})

const base = {
  content: '用户喜欢喝咖啡',
  memType: 'user' as const,
  tier: 'semantic' as const,
  importance: 8
}

describe('MemoryDao 主记录', () => {
  it('insert 后能 get,默认 confidence 0.7', () => {
    const m = dao.insertMemory(base)
    const got = dao.getMemory(m.id)!
    expect(got.content).toBe('用户喜欢喝咖啡')
    expect(got.confidence).toBeCloseTo(0.7)
    expect(got.supersededBy).toBeNull()
  })
  it('searchFts 用 bigram 命中中文', () => {
    dao.insertMemory(base)
    const hits = dao.searchFts('咖 啡 咖啡', 10)
    expect(hits.length).toBe(1)
  })
  it('softDelete 后 searchFts 过滤掉', () => {
    const m = dao.insertMemory(base)
    dao.softDelete(m.id)
    expect(dao.searchFts('咖 啡', 10).length).toBe(0)
  })
  it('supersede 把旧记录标失效', () => {
    const oldM = dao.insertMemory(base)
    const newM = dao.insertMemory({ ...base, content: '用户喜欢喝茶' })
    dao.supersede(oldM.id, newM.id)
    expect(dao.getMemory(oldM.id)!.supersededBy).toBe(newM.id)
    expect(dao.searchFts('咖 啡', 10).length).toBe(0)
  })
  it('bumpAccess 累加 access_count', () => {
    const m = dao.insertMemory(base)
    dao.bumpAccess(m.id)
    dao.bumpAccess(m.id)
    expect(dao.getMemory(m.id)!.accessCount).toBe(2)
  })
})

describe('MemoryDao episodes + links', () => {
  it('insertEpisode 默认 unconsolidated,可列出并标记', () => {
    const e = dao.insertEpisode({ content: '聊了咖啡', sessionKey: 'c1' })
    expect(dao.listUnconsolidated(10).map((x) => x.id)).toContain(e.id)
    dao.markConsolidated([e.id])
    expect(dao.listUnconsolidated(10).length).toBe(0)
  })
  it('addLink 后 linksOf 读出', () => {
    const a = dao.insertMemory(base)
    const b = dao.insertMemory({ ...base, content: '用户在北京' })
    dao.addLink({ fromId: a.id, toId: b.id, relation: 'related', weight: 0.8 })
    const links = dao.linksOf(a.id)
    expect(links).toHaveLength(1)
    expect(links[0].toId).toBe(b.id)
    expect(links[0].weight).toBeCloseTo(0.8)
  })
  it('demote 把 tier 改 archival', () => {
    const m = dao.insertMemory(base)
    dao.demote(m.id)
    expect(dao.getMemory(m.id)!.tier).toBe('archival')
  })
  it('updateMemory 重算 fts_content,旧词查不到新词查得到', () => {
    const m = dao.insertMemory(base)
    dao.updateMemory(m.id, { content: '用户改喝茶了' })
    expect(dao.searchFts('咖 啡', 10).length).toBe(0)
    expect(dao.searchFts('茶', 10).length).toBe(1)
  })
})
