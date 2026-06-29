import { describe, it, expect, vi } from 'vitest'

vi.mock('../llm', () => ({
  getLLMProvider: vi.fn(() => null),
  getLLMConfig: vi.fn(() => ({ baseUrl: 'u', apiKey: 'k', model: 'gpt-4o' })),
  setLLMConfig: vi.fn()
}))

import { buildTitlePrompt, generateTitle, setTitleModelConfig } from '../title'
import { getLLMProvider } from '../llm'
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
  it('returns empty when no provider available', async () => {
    vi.mocked(getLLMProvider).mockReturnValue(null)
    await expect(generateTitle('你好')).resolves.toBe('')
  })
  it('returns empty for blank input', async () => {
    await expect(generateTitle('   ')).resolves.toBe('')
  })
  it('returns sanitized title from provider deltas', async () => {
    const provider = fakeProvider([{ type: 'text', text: '快速排序实现' }])
    await expect(generateTitle('帮我写快排', { provider })).resolves.toBe('快速排序实现')
  })
  it('concatenates multiple text deltas before sanitizing', async () => {
    const provider = fakeProvider([
      { type: 'text', text: '快速' },
      { type: 'text', text: '排序' }
    ])
    await expect(generateTitle('帮我写快排', { provider })).resolves.toBe('快速排序')
  })
  it('returns empty when provider yields error', async () => {
    const provider = fakeProvider([{ type: 'error' }])
    await expect(generateTitle('帮我写快排', { provider })).resolves.toBe('')
  })
  it('passes the configured model name into the chat request', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let captured: any = null
    const provider = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chat: async function* (req: any): any {
        captured = req
        yield { type: 'text', text: '标题' }
      }
    } as unknown as ChatProvider
    await generateTitle('帮我写快排', { provider })
    expect(captured?.model).toBe('gpt-4o')
  })
  it('delegates setTitleModelConfig to setLLMConfig (compat shim)', async () => {
    const { setLLMConfig } = await import('../llm')
    setTitleModelConfig({ baseUrl: 'u', apiKey: 'k', model: 'm' })
    expect(vi.mocked(setLLMConfig)).toHaveBeenCalledWith({ baseUrl: 'u', apiKey: 'k', model: 'm' })
  })
})
