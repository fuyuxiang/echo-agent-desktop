import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../agent/providers/factory', () => ({
  createProvider: vi.fn((cfg) => ({ __provider: true, cfg }))
}))

import { setLLMConfig, getLLMConfig, getLLMProvider } from '../llm'
import { createProvider } from '../../agent/providers/factory'

describe('llm shared config', () => {
  beforeEach(() => { setLLMConfig(null); vi.clearAllMocks() })

  it('getLLMConfig returns null when unset', () => {
    expect(getLLMConfig()).toBeNull()
  })
  it('stores and returns config', () => {
    setLLMConfig({ baseUrl: 'u', apiKey: 'k', model: 'm' })
    expect(getLLMConfig()).toEqual({ baseUrl: 'u', apiKey: 'k', model: 'm' })
  })
  it('getLLMProvider returns null when no config', () => {
    expect(getLLMProvider()).toBeNull()
    expect(createProvider).not.toHaveBeenCalled()
  })
  it('getLLMProvider builds provider from config', () => {
    setLLMConfig({ baseUrl: 'u', apiKey: 'k', model: 'm' })
    const p = getLLMProvider()
    expect(p).not.toBeNull()
    expect(createProvider).toHaveBeenCalledWith({ providerId: 'openai', model: 'm', baseUrl: 'u', apiKey: 'k' })
    expect(p).toEqual({ __provider: true, cfg: { providerId: 'openai', model: 'm', baseUrl: 'u', apiKey: 'k' } })
  })
})
