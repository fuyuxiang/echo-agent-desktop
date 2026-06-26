import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../db/migrations'
import { MemoryDao } from '../dao'
import { Retriever } from '../retriever'
import { Extractor } from '../extractor'
import { Reflector } from '../reflector'
import { Linker } from '../linker'
import { Consolidator } from '../consolidator'
import type { MemoryLLM } from '../llm'

let db: Database.Database
let dao: MemoryDao
beforeEach(() => {
  db = new Database(':memory:')
  runMigrations(db)
  dao = new MemoryDao(db)
})

function mk(llm: MemoryLLM): Consolidator {
  const retriever = new Retriever(dao)
  return new Consolidator({
    dao,
    reflector: new Reflector(llm),
    extractor: new Extractor({ llm, dao, retriever }),
    linker: new Linker({ dao, retriever, llm }),
    llm
  })
}

describe('Consolidator.run 提炼', () => {
  it('未整合 episode 经反思落成 semantic 并标记 consolidated', async () => {
    dao.insertEpisode({ content: '我是后端工程师', sessionKey: 'c1' })
    const llm: MemoryLLM = {
      complete: vi
        .fn()
        // reflect
        .mockResolvedValueOnce('{"facts":[{"content":"用户是后端工程师","memType":"user","importance":8,"keywords":[],"tags":[]}]}')
        // decideAndApply -> ADD
        .mockResolvedValueOnce('{"op":"ADD","content":"用户是后端工程师","memType":"user","importance":8,"keywords":[],"tags":[],"contextDesc":""}')
    }
    await mk(llm).run()
    expect(dao.listSemantic(10, 0).some((m) => m.content === '用户是后端工程师')).toBe(true)
    expect(dao.listUnconsolidated(10).length).toBe(0)
  })

  it('LLM 不可用也标记 consolidated,防卡死重试', async () => {
    dao.insertEpisode({ content: '一些对话', sessionKey: 'c1' })
    const llm: MemoryLLM = { complete: vi.fn().mockResolvedValue(null) }
    await mk(llm).run()
    expect(dao.listUnconsolidated(10).length).toBe(0)
  })
})

describe('Consolidator.run 衰减/demote', () => {
  it('长期未访问记忆 confidence 衰减,低于阈值 demote 到 archival', async () => {
    const m = dao.insertMemory({ content: '陈旧事实', memType: 'user', tier: 'semantic', importance: 5, confidence: 0.25 })
    // 把 created_at/last_access 改成 60 天前
    const old = Date.now() - 60 * 86_400_000
    db.prepare('UPDATE personal_memory SET created_at=?, last_access=? WHERE id=?').run(old, old, m.id)
    const llm: MemoryLLM = { complete: vi.fn().mockResolvedValue(null) }
    await mk(llm).run()
    const after = dao.getMemory(m.id)!
    expect(after.confidence).toBeLessThan(0.25)
    expect(after.tier).toBe('archival')
  })

  it('近期访问的记忆不衰减', async () => {
    const m = dao.insertMemory({ content: '新鲜事实', memType: 'user', tier: 'semantic', importance: 5, confidence: 0.8 })
    dao.bumpAccess(m.id)
    const llm: MemoryLLM = { complete: vi.fn().mockResolvedValue(null) }
    await mk(llm).run()
    expect(dao.getMemory(m.id)!.confidence).toBeCloseTo(0.8)
  })
})
