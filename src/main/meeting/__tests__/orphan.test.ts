import { describe, it, expect } from 'vitest'
import { reapOrphans } from '../orphan'

describe('reapOrphans', () => {
  it('挑出 recording 状态的会议', () => {
    const ids = reapOrphans([
      { id: 'a', status: 'recording' },
      { id: 'b', status: 'done' },
      { id: 'c', status: 'recording' }
    ])
    expect(ids).toEqual(['a', 'c'])
  })
  it('无 recording 时返回空', () => {
    expect(reapOrphans([{ id: 'b', status: 'done' }])).toEqual([])
  })
})
