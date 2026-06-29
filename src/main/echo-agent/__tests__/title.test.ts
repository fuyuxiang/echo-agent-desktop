import { describe, it, expect } from 'vitest'
import { buildTitlePrompt, generateTitle, setTitleModelConfig } from '../title'
import type { ChatProvider } from '../../agent/providers/types'

function fakeProvider(deltas: Array<{ type: string; text?: string }>): ChatProvider {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    chat: async function* (): any {
      for (const d of deltas) yield d
    }
  } as unknown as ChatProvider
}

describe('buildTitlePrompt', () => {
  it('includes the user message and asks for a short chinese title', () => {
    const p = buildTitlePrompt('帮我写快排')
    expect(p).toContain('帮我写快排')
    expect(p).toMatch(/标题/)
  })
})

describe('generateTitle', () => {
  it('returns empty when no model config set', async () => {
    setTitleModelConfig(null)
    await expect(generateTitle('你好')).resolves.toBe('')
  })
  it('returns empty for blank input', async () => {
    setTitleModelConfig({ baseUrl: 'u', apiKey: 'k', model: 'm' })
    await expect(generateTitle('   ')).resolves.toBe('')
  })
  it('returns sanitized title from provider deltas', async () => {
    setTitleModelConfig({ baseUrl: 'u', apiKey: 'k', model: 'm' })
    const provider = fakeProvider([{ type: 'text', text: '快速排序实现' }])
    await expect(generateTitle('帮我写快排', { provider })).resolves.toBe('快速排序实现')
  })
  it('concatenates multiple text deltas before sanitizing', async () => {
    setTitleModelConfig({ baseUrl: 'u', apiKey: 'k', model: 'm' })
    const provider = fakeProvider([
      { type: 'text', text: '快速' },
      { type: 'text', text: '排序' }
    ])
    await expect(generateTitle('帮我写快排', { provider })).resolves.toBe('快速排序')
  })
  it('returns empty when provider yields error', async () => {
    setTitleModelConfig({ baseUrl: 'u', apiKey: 'k', model: 'm' })
    const provider = fakeProvider([{ type: 'error' }])
    await expect(generateTitle('帮我写快排', { provider })).resolves.toBe('')
  })
})
