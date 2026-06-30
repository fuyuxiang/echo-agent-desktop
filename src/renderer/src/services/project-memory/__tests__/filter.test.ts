import { describe, it, expect } from 'vitest'
import { selectShareableMemories, type CognitiveEntry } from '../filter'

function e(id: string, content: string, tags: string[], importance = 0.5): CognitiveEntry {
  return { id, content, tags, importance }
}

describe('selectShareableMemories', () => {
  it('selects entries tagged project or shared', () => {
    const out = selectShareableMemories([
      e('1', '部署规范', ['project']),
      e('2', '我的口味', ['personal']),
      e('3', '团队约定', ['shared', 'x'])
    ])
    expect(out).toEqual([
      { content: '部署规范', tags: ['project'] },
      { content: '团队约定', tags: ['shared', 'x'] }
    ])
  })
  it('dedupes by content', () => {
    const out = selectShareableMemories([e('1', 'X', ['project']), e('2', 'X', ['shared'])])
    expect(out).toHaveLength(1)
  })
  it('skips empty content', () => {
    expect(selectShareableMemories([e('1', '   ', ['project'])])).toEqual([])
  })
  it('returns empty when nothing tagged shareable', () => {
    expect(selectShareableMemories([e('1', 'x', ['personal'])])).toEqual([])
  })
})
