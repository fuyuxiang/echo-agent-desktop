import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../db/migrations'
import { MemoryDao } from '../dao'
import { Linker } from '../linker'
import type { MemoryLLM } from '../llm'
import type { Retriever } from '../retriever'
import type { ScoredMemory } from '../types'

let db: Database.Database
let dao: MemoryDao
const noLlm: MemoryLLM = { complete: vi.fn().mockResolvedValue(null) }

// 用可控候选的 stub retriever,避免 FTS5 AND 行为干扰(只测 linker 自己的 judge 逻辑)
function stubRetriever(candidates: ScoredMemory[]): Retriever {
  return {
    retrieve: vi.fn().mockReturnValue(candidates)
  } as unknown as Retriever
}

function scored(id: number, content: string, score: number, tags: string[] = [], keywords: string[] = []): ScoredMemory {
  return {
    record: {
      id,
      content,
      memType: 'user',
      tier: 'semantic',
      keywords,
      tags,
      contextDesc: '',
      importance: 5,
      confidence: 0.7,
      salience: null,
      provenance: null,
      accessCount: 0,
      lastAccess: null,
      createdAt: 0,
      updatedAt: 0,
      supersededBy: null
    },
    relevance: score,
    recency: 1,
    importanceScore: 0.5,
    score
  }
}

beforeEach(() => {
  db = new Database(':memory:')
  runMigrations(db)
  dao = new MemoryDao(db)
})

describe('Linker.link 同步建链', () => {
  it('tag 有交集时建 related 链接(weight=交集/并集)', () => {
    const a = dao.insertMemory({ content: 'a', memType: 'user', tier: 'semantic', importance: 7, tags: ['饮品'] })
    const b = dao.insertMemory({ content: 'b', memType: 'user', tier: 'semantic', importance: 6, tags: ['饮品'] })
    const retriever = stubRetriever([scored(a.id, 'a', 0.5, ['饮品'], []), scored(b.id, 'b', 0.5, ['饮品'], [])])
    // 把 b 自己的候选过滤掉(模拟实际 retriever 不返回自身)
    ;(retriever.retrieve as ReturnType<typeof vi.fn>).mockReturnValue([scored(a.id, 'a', 0.5, ['饮品'], [])])
    new Linker({ dao, retriever, llm: noLlm }).link(b.id)
    const links = dao.linksOf(b.id)
    expect(links.length).toBe(1)
    expect(links[0].relation).toBe('related')
    expect(links[0].toId).toBe(a.id)
  })

  it('不与自身建链,最多 3 条', () => {
    const ids: number[] = []
    for (let i = 0; i < 5; i++) ids.push(dao.insertMemory({ content: `m${i}`, memType: 'user', tier: 'semantic', importance: 5 }).id)
    const target = dao.insertMemory({ content: 'tgt', memType: 'user', tier: 'semantic', importance: 5 }).id
    const retriever = stubRetriever(ids.map((id) => scored(id, 'x', 0.5)))
    new Linker({ dao, retriever, llm: noLlm }).link(target)
    const links = dao.linksOf(target)
    expect(links.every((l) => !(l.fromId === target && l.toId === target))).toBe(true)
    expect(links.length).toBeLessThanOrEqual(3)
  })

  it('无相似记忆时不建链', () => {
    const x = dao.insertMemory({ content: 'x', memType: 'user', tier: 'semantic', importance: 5 }).id
    const retriever = stubRetriever([])
    new Linker({ dao, retriever, llm: noLlm }).link(x)
    expect(dao.linksOf(x).length).toBe(0)
  })

  it('无 tag/keyword 交集时建 similar 链接', () => {
    const a = dao.insertMemory({ content: 'a', memType: 'user', tier: 'semantic', importance: 5 })
    const b = dao.insertMemory({ content: 'b', memType: 'user', tier: 'semantic', importance: 5 })
    const retriever = stubRetriever([scored(a.id, 'a', 0.5, [], [])])
    new Linker({ dao, retriever, llm: noLlm }).link(b.id)
    const links = dao.linksOf(b.id)
    expect(links.length).toBe(1)
    expect(links[0].relation).toBe('similar')
  })
})

describe('Linker.evolve 异步演化', () => {
  it('LLM 判定 update=true 时只改 contextDesc/tags,不动 content/importance', async () => {
    const a = dao.insertMemory({ content: '用户喜欢咖啡', memType: 'user', tier: 'semantic', importance: 7, tags: ['饮品'], contextDesc: '旧描述' })
    const b = dao.insertMemory({ content: '用户爱喝拿铁', memType: 'user', tier: 'semantic', importance: 6, tags: ['饮品'] })
    dao.addLink({ fromId: b.id, toId: a.id, relation: 'related', weight: 0.8 })
    const llm: MemoryLLM = {
      complete: vi.fn().mockResolvedValue('{"update":true,"contextDesc":"与拿铁偏好相关","tags":["饮品","咖啡"]}')
    }
    await new Linker({ dao, retriever: stubRetriever([]), llm }).evolve([b.id])
    const updated = dao.getMemory(a.id)!
    expect(updated.contextDesc).toBe('与拿铁偏好相关')
    expect(updated.tags).toContain('咖啡')
    expect(updated.content).toBe('用户喜欢咖啡') // content 不变
    expect(updated.importance).toBe(7) // importance 不变
  })

  it('LLM 不可用(null)时不改任何东西', async () => {
    const a = dao.insertMemory({ content: '用户喜欢咖啡', memType: 'user', tier: 'semantic', importance: 7, contextDesc: '原描述' })
    const b = dao.insertMemory({ content: '用户爱喝拿铁', memType: 'user', tier: 'semantic', importance: 6 })
    dao.addLink({ fromId: b.id, toId: a.id, relation: 'related', weight: 0.8 })
    await new Linker({ dao, retriever: stubRetriever([]), llm: noLlm }).evolve([b.id])
    expect(dao.getMemory(a.id)!.contextDesc).toBe('原描述')
  })
})
