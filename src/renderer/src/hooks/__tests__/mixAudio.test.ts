import { describe, it, expect } from 'vitest'
import { mixToMono } from '../useMeetingRecorder'

describe('mixToMono', () => {
  it('单路时原样返回副本', () => {
    const a = new Float32Array([0.1, 0.2])
    const out = mixToMono(a, null)
    expect(out).toEqual(new Float32Array([0.1, 0.2]))
    expect(out).not.toBe(a)
  })
  it('两路逐样本相加', () => {
    const out = mixToMono(new Float32Array([0.1, 0.2]), new Float32Array([0.3, 0.3]))
    expect(out[0]).toBeCloseTo(0.4)
    expect(out[1]).toBeCloseTo(0.5)
  })
  it('相加超界 clamp 到 [-1,1]', () => {
    const out = mixToMono(new Float32Array([0.8]), new Float32Array([0.8]))
    expect(out[0]).toBe(1)
  })
  it('长度不等按较短对齐', () => {
    const out = mixToMono(new Float32Array([0.1, 0.2, 0.3]), new Float32Array([0.1]))
    expect(out.length).toBe(1)
    expect(out[0]).toBeCloseTo(0.2)
  })
})
