import { describe, it, expect } from 'vitest'
import { resolveEffectiveModelConfig } from '../model-config'

describe('resolveEffectiveModelConfig', () => {
  const server = {
    baseUrl: 'https://srv',
    modelName: 'srv-model',
    allowLocalOverride: false,
    hasCredential: true
  }
  it('uses server when override disallowed', () => {
    const r = resolveEffectiveModelConfig(server, {
      baseUrl: 'https://local',
      modelName: 'local-model'
    })
    expect(r.source).toBe('server')
    expect(r.baseUrl).toBe('https://srv')
  })
  it('uses local when override allowed and local present', () => {
    const r = resolveEffectiveModelConfig(
      { ...server, allowLocalOverride: true },
      { baseUrl: 'https://local', modelName: 'local-model' }
    )
    expect(r.source).toBe('local')
    expect(r.baseUrl).toBe('https://local')
  })
  it('falls back to server when override allowed but no local', () => {
    const r = resolveEffectiveModelConfig({ ...server, allowLocalOverride: true }, null)
    expect(r.source).toBe('server')
  })
})
