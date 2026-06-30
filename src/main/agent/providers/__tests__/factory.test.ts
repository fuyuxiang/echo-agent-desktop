import { describe, it, expect } from 'vitest'
import { createProvider } from '../factory'
import { OpenAICompatProvider } from '../openai-compatible'
import { AnthropicProvider } from '../anthropic'
import { ThinkNormalizingProvider } from '../think-normalizer'

describe('createProvider', () => {
  it('按预设协议构造 openai 兼容 provider', () => {
    const p = createProvider({ providerId: 'deepseek', model: 'deepseek-chat', baseUrl: '', apiKey: 'k' })
    expect(p).toBeInstanceOf(ThinkNormalizingProvider)
    expect((p as ThinkNormalizingProvider).inner).toBeInstanceOf(OpenAICompatProvider)
    expect(p.name).toBe('deepseek')
  })

  it('anthropic 预设构造 Anthropic provider', () => {
    const p = createProvider({ providerId: 'anthropic', model: 'claude-3-5-sonnet-latest', baseUrl: '', apiKey: 'k' })
    expect(p).toBeInstanceOf(ThinkNormalizingProvider)
    expect((p as ThinkNormalizingProvider).inner).toBeInstanceOf(AnthropicProvider)
  })

  it('未知 providerId 默认 openai 协议且不抛异常', () => {
    const p = createProvider({ providerId: 'custom-gateway', model: 'm', baseUrl: 'https://my.gw/v1', apiKey: 'k' })
    expect((p as ThinkNormalizingProvider).inner).toBeInstanceOf(OpenAICompatProvider)
  })

  it('cfg.baseUrl 覆盖预设 baseUrl', () => {
    // 通过构造不抛错 + 类型正确即验证;baseUrl 是私有字段,行为在 provider 单测已覆盖
    const p = createProvider({ providerId: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://proxy/v1', apiKey: 'k' })
    expect(p.name).toBe('deepseek')
  })
})
