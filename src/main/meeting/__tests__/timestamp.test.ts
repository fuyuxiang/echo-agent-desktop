import { describe, it, expect } from 'vitest'
import { samplesToMs } from '../../asr/index'

describe('samplesToMs', () => {
  it('16000 samples = 1000ms', () => {
    expect(samplesToMs(16000)).toBe(1000)
  })
  it('8000 samples = 500ms', () => {
    expect(samplesToMs(8000)).toBe(500)
  })
  it('自定义采样率', () => {
    expect(samplesToMs(48000, 48000)).toBe(1000)
  })
})
