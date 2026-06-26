// src/main/agent/tools/__tests__/facades.test.ts
import { describe, it, expect } from 'vitest'
import { NoopMemoryGateway } from '../memory-facade'
import { NoopSkillGateway } from '../skill-facade'

describe('冻结门面 Noop 实现', () => {
  it('NoopMemoryGateway.recall 返回空数组', async () => {
    expect(await new NoopMemoryGateway().recall('q', 'c1')).toEqual([])
  })
  it('NoopMemoryGateway.capture 不抛', async () => {
    await expect(new NoopMemoryGateway().capture('c1', [])).resolves.toBeUndefined()
  })
  it('NoopSkillGateway 返回空提示与空工具', () => {
    const g = new NoopSkillGateway()
    expect(g.activePromptFragments()).toEqual([])
    expect(g.tools()).toEqual([])
  })
})
