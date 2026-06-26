// src/main/agent/memory/__tests__/extractor.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../db/migrations'
import { MemoryDao } from '../dao'
import { Retriever } from '../retriever'
import { Extractor } from '../extractor'
import type { MemoryLLM } from '../llm'

let dao: MemoryDao
let retriever: Retriever
beforeEach(() => {
  const db = new Database(':memory:')
  runMigrations(db)
  dao = new MemoryDao(db)
  retriever = new Retriever(dao)
})

// 顺序返回脚本化响应
function scriptLLM(responses: string[]): MemoryLLM {
  let i = 0
  return { complete: async () => responses[i++] ?? null }
}

const prov = { sessionKey: 'c1', messageIds: [1, 2] }

describe('Extractor', () => {
  it('ADD: 抽到新事实写入', async () => {
    const llm = scriptLLM([
      JSON.stringify({ facts: ['用户喜欢咖啡'] }),
      JSON.stringify({ op: 'ADD', content: '用户喜欢咖啡', memType: 'user', importance: 8, keywords: ['咖啡'], tags: [], contextDesc: '偏好' })
    ])
    const ex = new Extractor({ llm, dao, retriever })
    const ids = await ex.extract({ userText: '我喜欢咖啡', assistantText: 'ok', provenance: prov })
    expect(ids).toHaveLength(1)
    expect(dao.getMemory(ids[0])!.content).toBe('用户喜欢咖啡')
  })
  it('UPDATE: 旧记忆被 supersede', async () => {
    const old = dao.insertMemory({ content: '用户喜欢咖啡', memType: 'user', tier: 'semantic', importance: 7 })
    const llm = scriptLLM([
      JSON.stringify({ facts: ['用户现在喜欢茶'] }),
      JSON.stringify({ op: 'UPDATE', targetId: old.id, content: '用户喜欢茶', importance: 7 })
    ])
    const ex = new Extractor({ llm, dao, retriever })
    const ids = await ex.extract({ userText: '我改喝茶了', assistantText: 'ok', provenance: prov })
    expect(dao.getMemory(old.id)!.supersededBy).toBe(ids[0])
  })
  it('DELETE: 旧记忆软失效', async () => {
    const old = dao.insertMemory({ content: '用户喜欢咖啡', memType: 'user', tier: 'semantic', importance: 7 })
    const llm = scriptLLM([
      JSON.stringify({ facts: ['用户不再喝咖啡'] }),
      JSON.stringify({ op: 'DELETE', targetId: old.id })
    ])
    const ex = new Extractor({ llm, dao, retriever })
    await ex.extract({ userText: '我戒咖啡了', assistantText: 'ok', provenance: prov })
    expect(dao.getMemory(old.id)!.supersededBy).toBe(old.id)
  })
  it('离线(LLM null)返回空,不写入', async () => {
    const ex = new Extractor({ llm: scriptLLM([]), dao, retriever })
    expect(await ex.extract({ userText: 'x', assistantText: 'y', provenance: prov })).toEqual([])
  })
})

describe('Extractor.decideAndApply', () => {
  it('对单条 fact 做 ADD 决策并落库,返回新 id', async () => {
    const llm: MemoryLLM = {
      complete: async () =>
        '{"op":"ADD","content":"用户喜欢喝美式","memType":"user","importance":7,"keywords":["咖啡"],"tags":["偏好"],"contextDesc":""}'
    }
    const ext = new Extractor({ llm, dao, retriever })
    const id = await ext.decideAndApply('用户喜欢喝美式咖啡', { sessionKey: 'c1', messageIds: [] })
    expect(id).not.toBeNull()
    expect(dao.getMemory(id!)!.content).toBe('用户喜欢喝美式')
  })

  it('LLM 返回 NOOP 时不落库返回 null', async () => {
    const llm: MemoryLLM = { complete: async () => '{"op":"NOOP"}' }
    const ext = new Extractor({ llm, dao, retriever })
    const id = await ext.decideAndApply('无关闲聊', { sessionKey: 'c1', messageIds: [] })
    expect(id).toBeNull()
  })
})