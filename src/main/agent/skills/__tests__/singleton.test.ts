import { describe, it, expect, afterEach } from 'vitest'
import { getSkillManager, resetSkillManagerForTest } from '../singleton'

afterEach(() => resetSkillManagerForTest())

describe('skills singleton', () => {
  it('懒构造返回同一实例且含内置技能', () => {
    const a = getSkillManager()
    const b = getSkillManager()
    expect(a).toBe(b)
    expect(a.list().map((m) => m.id)).toContain('ppt')
  })
})
