import { describe, it, expect } from 'vitest'
import { alignSpeaker } from '../diarization'

const diar = [
  { start: 0, end: 5, speaker: 0 },
  { start: 5, end: 10, speaker: 1 }
]

describe('alignSpeaker', () => {
  it('段落落在簇0区间内', () => {
    expect(alignSpeaker(1000, 3000, diar)).toBe('speaker_0')
  })
  it('段落落在簇1区间内', () => {
    expect(alignSpeaker(6000, 9000, diar)).toBe('speaker_1')
  })
  it('跨界取重叠更大的簇', () => {
    expect(alignSpeaker(4000, 9000, diar)).toBe('speaker_1')
  })
  it('无重叠返回 null', () => {
    expect(alignSpeaker(20000, 25000, diar)).toBeNull()
  })
})
