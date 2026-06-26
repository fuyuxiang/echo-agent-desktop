import { describe, it, expect, vi } from 'vitest'
import { Reflector } from '../reflector'
import type { MemoryLLM } from '../llm'
import type { Episode } from '../types'

function ep(content: string): Episode {
  return { id: 1, content, entities: [], sessionKey: 'c1', messageRange: null, importance: null, consolidated: false, ts: Date.now() }
}

describe('Reflector.reflect', () => {
  it('从 episode 归纳出结构化 facts', async () => {
    const llm: MemoryLLM = {
      complete: vi.fn().mockResolvedValue(
        '{"facts":[{"content":"用户是后端工程师","memType":"user","importance":8,"keywords":["职业"],"tags":["背景"]}]}'
      )
    }
    const facts = await new Reflector(llm).reflect([ep('我平时写 Go 后端'), ep('我们团队在做微服务')])
    expect(facts.length).toBe(1)
    expect(facts[0].content).toBe('用户是后端工程师')
    expect(facts[0].memType).toBe('user')
  })

  it('空输入直接返回空,不调 LLM', async () => {
    const llm: MemoryLLM = { complete: vi.fn() }
    const facts = await new Reflector(llm).reflect([])
    expect(facts).toEqual([])
    expect(llm.complete).not.toHaveBeenCalled()
  })

  it('LLM 不可用(null)返回空', async () => {
    const llm: MemoryLLM = { complete: vi.fn().mockResolvedValue(null) }
    const facts = await new Reflector(llm).reflect([ep('一些对话')])
    expect(facts).toEqual([])
  })

  it('过滤缺字段的脏 fact', async () => {
    const llm: MemoryLLM = {
      complete: vi.fn().mockResolvedValue('{"facts":[{"content":"","memType":"user","importance":5},{"memType":"user"}]}')
    }
    const facts = await new Reflector(llm).reflect([ep('x')])
    expect(facts).toEqual([])
  })
})
