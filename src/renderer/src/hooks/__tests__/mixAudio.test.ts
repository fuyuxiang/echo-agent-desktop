import { describe, it, expect } from 'vitest'
import { applyGain, mixToMono } from '../useMeetingRecorder'

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

describe('applyGain', () => {
  it('静音帧不放大并返回原数组', () => {
    const input = new Float32Array([0.001, -0.001])
    expect(applyGain(input)).toBe(input)
  })

  it('按目标峰值放大并 clamp 到 [-1,1]', () => {
    const out = applyGain(new Float32Array([0.1, -0.2]), 0.6, 12)
    expect(out[0]).toBeCloseTo(0.3)
    expect(out[1]).toBeCloseTo(-0.6)

    const clipped = applyGain(new Float32Array([0.1]), 2, 50)
    expect(clipped[0]).toBe(1)
  })

  it('峰值已达目标时返回原数组', () => {
    const input = new Float32Array([0.8])
    expect(applyGain(input, 0.5)).toBe(input)
  })
})
