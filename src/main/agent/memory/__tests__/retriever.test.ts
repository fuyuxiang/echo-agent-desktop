// src/main/agent/memory/__tests__/retriever.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../db/migrations'
import { MemoryDao } from '../dao'
import { Retriever } from '../retriever'

let dao: MemoryDao
beforeEach(() => {
  const db = new Database(':memory:')
  runMigrations(db)
  dao = new MemoryDao(db)
})

describe('Retriever 三因子', () => {
  it('相关命中按 score 降序', () => {
    dao.insertMemory({ content: '用户喜欢咖啡', memType: 'user', tier: 'semantic', importance: 9 })
    dao.insertMemory({ content: '用户喜欢茶', memType: 'user', tier: 'semantic', importance: 3 })
    const r = new Retriever(dao).retrieve('咖啡')
    expect(r.length).toBeGreaterThanOrEqual(1)
    expect(r[0].record.content).toContain('咖啡')
    expect(r[0].score).toBeGreaterThan(0)
  })
  it('importance 高者在相关度相同时排前', () => {
    const hi = dao.insertMemory({ content: '用户重要事实甲', memType: 'user', tier: 'semantic', importance: 10 })
    dao.insertMemory({ content: '用户重要事实甲', memType: 'user', tier: 'semantic', importance: 1 })
    const r = new Retriever(dao).retrieve('重要事实甲', { topK: 2, expandLinks: false })
    expect(r[0].record.id).toBe(hi.id)
  })
  it('置信度低者降权', () => {
    const a = dao.insertMemory({ content: '矛盾事实乙', memType: 'user', tier: 'semantic', importance: 5 })
    const b = dao.insertMemory({ content: '矛盾事实乙', memType: 'user', tier: 'semantic', importance: 5 })
    dao.setConfidence(a.id, 0.1)
    const r = new Retriever(dao).retrieve('矛盾事实乙', { topK: 2, expandLinks: false })
    expect(r[0].record.id).toBe(b.id) // 高置信在前
  })
  it('expandLinks 沿链接补一跳', () => {
    const a = dao.insertMemory({ content: '用户住北京', memType: 'user', tier: 'semantic', importance: 6 })
    const b = dao.insertMemory({ content: '北京天气干燥', memType: 'environment', tier: 'semantic', importance: 6 })
    dao.addLink({ fromId: a.id, toId: b.id, relation: 'related', weight: 0.9 })
    const r = new Retriever(dao).retrieve('北京', { topK: 2, expandLinks: true })
    const ids = r.map((x) => x.record.id)
    expect(ids).toContain(b.id)
  })
})
