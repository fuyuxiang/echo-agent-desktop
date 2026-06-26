// src/main/agent/memory/__tests__/encoder.test.ts
import { describe, it, expect } from 'vitest'
import { Encoder } from '../encoder'
import type { MemoryLLM } from '../llm'

const llmReturning = (s: string | null): MemoryLLM => ({ complete: async () => s })

describe('Encoder.salience', () => {
  it('LLM 返回分数被解析', async () => {
    const enc = new Encoder(llmReturning('{"salience":0.9}'))
    expect(await enc.salience({ userText: '我叫Alice', assistantText: '你好Alice' })).toBeCloseTo(0.9)
  })
  it('LLM 不可用时启发式兜底:含偏好关键词给较高分', async () => {
    const enc = new Encoder(llmReturning(null))
    expect(await enc.salience({ userText: '我喜欢喝咖啡', assistantText: 'ok' })).toBeGreaterThanOrEqual(0.5)
  })
  it('LLM 不可用且无关键词给低分', async () => {
    const enc = new Encoder(llmReturning(null))
    expect(await enc.salience({ userText: '嗯', assistantText: '好的' })).toBeLessThan(0.5)
  })
})