// src/main/agent/providers/__tests__/presets.test.ts
import { describe, it, expect } from 'vitest'
import { PROVIDER_PRESETS, getPreset } from '../presets'

describe('provider presets', () => {
  it('覆盖国内外主流厂商', () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id)
    for (const id of ['deepseek', 'qwen', 'moonshot', 'zhipu', 'baichuan', 'minimax', 'stepfun', 'siliconflow', 'doubao', 'ernie', 'openai', 'anthropic', 'gemini']) {
      expect(ids).toContain(id)
    }
  })

  it('每条预设 baseUrl 与 models 非空、protocol 合法', () => {
    for (const p of PROVIDER_PRESETS) {
      expect(p.baseUrl).toMatch(/^https?:\/\//)
      expect(p.models.length).toBeGreaterThan(0)
      expect(['openai', 'anthropic']).toContain(p.protocol)
    }
  })

  it('anthropic 用 anthropic 协议,其余主用 openai', () => {
    expect(getPreset('anthropic')?.protocol).toBe('anthropic')
    expect(getPreset('deepseek')?.protocol).toBe('openai')
  })

  it('getPreset 未知 id 返回 undefined', () => {
    expect(getPreset('nope')).toBeUndefined()
  })
})
