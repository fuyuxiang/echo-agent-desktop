import { describe, it, expect } from 'vitest'
import { parseListResponse } from '../cognitive-memory'

describe('parseListResponse', () => {
  it('maps entries to CognitiveEntry, keeping needed fields', () => {
    const json = {
      entries: [
        { id: 'm1', type: 'user', tier: 'semantic', key: 'k', content: '部署规范', tags: ['project'], importance: 0.8 },
        { id: 'm2', content: '口味', tags: [], importance: 0.3 }
      ],
      total: 2
    }
    expect(parseListResponse(json)).toEqual([
      { id: 'm1', content: '部署规范', tags: ['project'], importance: 0.8 },
      { id: 'm2', content: '口味', tags: [], importance: 0.3 }
    ])
  })
  it('returns [] for malformed input', () => {
    expect(parseListResponse(null)).toEqual([])
    expect(parseListResponse({})).toEqual([])
    expect(parseListResponse({ entries: 'x' })).toEqual([])
  })
  it('defaults missing fields safely', () => {
    expect(parseListResponse({ entries: [{ id: 'm1' }] })).toEqual([
      { id: 'm1', content: '', tags: [], importance: 0 }
    ])
  })
})
