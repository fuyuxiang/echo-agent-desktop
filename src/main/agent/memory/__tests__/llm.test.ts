// src/main/agent/memory/__tests__/llm.test.ts
import { describe, it, expect } from 'vitest'
import { ProviderMemoryLLM, parseJsonLoose } from '../llm'
import type { ChatProvider, ChatDelta } from '../../providers'

function provider(deltas: ChatDelta[], err?: boolean): ChatProvider {
  return {
    name: 'mock',
    async *chat() {
      if (err) throw new Error('offline')
      for (const d of deltas) yield d
    }
  }
}

describe('ProviderMemoryLLM', () => {
  it('聚合 text delta 成整串', async () => {
    const llm = new ProviderMemoryLLM({
      provider: provider([{ type: 'text', text: '{"op":' }, { type: 'text', text: '"NOOP"}' }, { type: 'done' }]),
      model: 'm'
    })
    expect(await llm.complete('p')).toBe('{"op":"NOOP"}')
  })
  it('provider 抛错返回 null 不抛', async () => {
    const llm = new ProviderMemoryLLM({ provider: provider([], true), model: 'm' })
    expect(await llm.complete('p')).toBeNull()
  })
})

describe('parseJsonLoose', () => {
  it('剥 json 围栏', () => {
    expect(parseJsonLoose<{ a: number }>('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })
  it('裸 JSON', () => {
    expect(parseJsonLoose<{ a: number }>('{"a":2}')).toEqual({ a: 2 })
  })
  it('null 输入返回 null', () => {
    expect(parseJsonLoose('')).toBeNull()
    expect(parseJsonLoose(null)).toBeNull()
  })
  it('非法 JSON 返回 null', () => {
    expect(parseJsonLoose('not json')).toBeNull()
  })
})
