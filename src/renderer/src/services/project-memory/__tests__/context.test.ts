import { describe, it, expect } from 'vitest'
import { buildProjectMemoryContext } from '../context'
import type { ProjectMemory } from '@/services/server'

function pm(id: string, content: string): ProjectMemory {
  return { id, groupId: 'g', content, tags: [], sourceUser: 'u', createdAt: 0, updatedAt: 0 }
}

describe('buildProjectMemoryContext', () => {
  it('returns user text unchanged when no hits', () => {
    expect(buildProjectMemoryContext([], '帮我部署')).toBe('帮我部署')
  })
  it('prefixes project memory block before user text', () => {
    const out = buildProjectMemoryContext([pm('1', '用蓝绿部署'), pm('2', '灰度 10%')], '帮我部署')
    expect(out).toContain('用蓝绿部署')
    expect(out).toContain('- 用蓝绿部署')
    expect(out).toContain('灰度 10%')
    expect(out.endsWith('帮我部署')).toBe(true)
    expect(out).toMatch(/项目记忆/)
  })
})
