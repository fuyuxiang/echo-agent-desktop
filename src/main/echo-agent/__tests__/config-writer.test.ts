import { describe, it, expect } from 'vitest'
import { parse } from 'yaml'
import { mergeModelsBlock } from '../config-writer'

const cfg = { baseUrl: 'https://api.x.com/v1', apiKey: 'sk-abc', model: 'gpt-4o' }

describe('mergeModelsBlock', () => {
  it('writes models block on empty yaml', () => {
    const out = parse(mergeModelsBlock('', cfg))
    expect(out.models.default_model).toBe('gpt-4o')
    expect(out.models.providers).toEqual([
      { name: 'desktop', apiKey: 'sk-abc', apiBase: 'https://api.x.com/v1', models: ['gpt-4o'] }
    ])
  })

  it('preserves other top-level keys', () => {
    const existing = 'memory:\n  enabled: true\ngateway:\n  port: 0\n'
    const out = parse(mergeModelsBlock(existing, cfg))
    expect(out.memory).toEqual({ enabled: true })
    expect(out.gateway).toEqual({ port: 0 })
    expect(out.models.default_model).toBe('gpt-4o')
  })

  it('overwrites a pre-existing models block', () => {
    const existing = 'models:\n  default_model: old\n  providers:\n    - name: old\nfoo: bar\n'
    const out = parse(mergeModelsBlock(existing, cfg))
    expect(out.models.default_model).toBe('gpt-4o')
    expect(out.models.providers).toHaveLength(1)
    expect(out.models.providers[0].name).toBe('desktop')
    expect(out.foo).toBe('bar')
  })
})
