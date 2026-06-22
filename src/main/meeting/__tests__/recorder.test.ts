import { describe, it, expect } from 'vitest'
import { floatTo16BitPCM, buildWavHeader } from '../recorder'

describe('recorder 纯函数', () => {
  it('floatTo16BitPCM 把 [-1,1] 映射到 int16', () => {
    const buf = floatTo16BitPCM(new Float32Array([0, 1, -1]))
    expect(buf.length).toBe(6)
    expect(buf.readInt16LE(0)).toBe(0)
    expect(buf.readInt16LE(2)).toBe(32767)
    expect(buf.readInt16LE(4)).toBe(-32768)
  })
  it('floatTo16BitPCM 截断超界值', () => {
    const buf = floatTo16BitPCM(new Float32Array([2, -2]))
    expect(buf.readInt16LE(0)).toBe(32767)
    expect(buf.readInt16LE(2)).toBe(-32768)
  })
  it('buildWavHeader 是 44 字节且标记 RIFF/WAVE', () => {
    const h = buildWavHeader(1000, 16000)
    expect(h.length).toBe(44)
    expect(h.toString('ascii', 0, 4)).toBe('RIFF')
    expect(h.toString('ascii', 8, 12)).toBe('WAVE')
    expect(h.readUInt32LE(24)).toBe(16000)
  })
})
