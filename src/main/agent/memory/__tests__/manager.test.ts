import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../db/migrations'
import { MemoryManager } from '../manager'
import type { ChatProvider, ChatDelta } from '../../providers'

function providerYielding(text: string): ChatProvider {
  return {
    name: 'fake',
    async *chat(): AsyncIterable<ChatDelta> {
      yield { type: 'text', text }
      yield { type: 'done' }
    }
  }
}
// 永不命中显著性、永不抽取的 provider(salience 低)
const lowSalience = providerYielding('{"salience":0.1}')

let db: Database.Database
beforeEach(() => {
  db = new Database(':memory:')
  runMigrations(db)
})
afterEach(() => vi.restoreAllMocks())

describe('MemoryManager.capture', () => {
  it('低显著性也落 episode 但不抽语义', async () => {
    const mgr = new MemoryManager({ db, provider: lowSalience, model: 'm', opts: { checkMs: 9_999_999 } })
    await mgr.capture('c1', [
      { role: 'user', content: '今天天气不错' },
      { role: 'assistant', content: '是的呢' }
    ])
    await mgr.flush()
    const epCount = (db.prepare('SELECT COUNT(*) n FROM memory_episodes').get() as { n: number }).n
    const memCount = (db.prepare('SELECT COUNT(*) n FROM personal_memory').get() as { n: number }).n
    expect(epCount).toBe(1)
    expect(memCount).toBe(0)
    mgr.dispose()
  })

  it('capture 串行执行: 连发两次按入队顺序跑', async () => {
    const mgr = new MemoryManager({ db, provider: lowSalience, model: 'm', opts: { checkMs: 9_999_999 } })
    await mgr.capture('c1', [{ role: 'user', content: '第一条' }, { role: 'assistant', content: 'a' }])
    await mgr.capture('c1', [{ role: 'user', content: '第二条' }, { role: 'assistant', content: 'b' }])
    await mgr.flush()
    const rows = db.prepare('SELECT content FROM memory_episodes ORDER BY id').all() as Array<{ content: string }>
    expect(rows[0].content).toContain('第一条')
    expect(rows[1].content).toContain('第二条')
    mgr.dispose()
  })

  it('LLM 不可用(provider 抛错)仍落 episode 不崩', async () => {
    const provider: ChatProvider = {
      name: 'fake',
      // eslint-disable-next-line require-yield
      async *chat(): AsyncIterable<ChatDelta> {
        throw new Error('network down')
      }
    }
    const mgr = new MemoryManager({ db, provider, model: 'm', opts: { checkMs: 9_999_999 } })
    await mgr.capture('c1', [{ role: 'user', content: '我叫张三' }, { role: 'assistant', content: '你好' }])
    await mgr.flush()
    expect((db.prepare('SELECT COUNT(*) n FROM memory_episodes').get() as { n: number }).n).toBe(1)
    mgr.dispose()
  })
})

describe('MemoryManager.recall', () => {
  it('召回相关记忆转成 MemoryHit', async () => {
    const mgr = new MemoryManager({ db, provider: lowSalience, model: 'm', opts: { checkMs: 9_999_999 } })
    mgr['dao'].insertMemory({ content: '用户喜欢咖啡', memType: 'user', tier: 'semantic', importance: 8 })
    const hits = await mgr.recall('咖啡', 'c1')
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0]).toHaveProperty('id')
    expect(hits[0]).toHaveProperty('text')
    expect(hits[0]).toHaveProperty('score')
    mgr.dispose()
  })
})

describe('MemoryManager.dispose', () => {
  it('dispose 后清掉定时器(不再触发)', () => {
    const spy = vi.spyOn(global, 'clearInterval')
    const mgr = new MemoryManager({ db, provider: lowSalience, model: 'm', opts: { checkMs: 9_999_999 } })
    mgr.dispose()
    expect(spy).toHaveBeenCalled()
  })
})
