import { describe, it, expect } from 'vitest'
import { ThinkNormalizingProvider } from '../think-normalizer'
import type { ChatProvider, ChatDelta, ChatRequest } from '../types'

/** 用预设 delta 序列构造的假 provider */
function fakeProvider(deltas: ChatDelta[]): ChatProvider {
  return {
    name: 'fake',
    async *chat(_req: ChatRequest, _signal: AbortSignal): AsyncIterable<ChatDelta> {
      for (const d of deltas) yield d
    }
  }
}

async function collect(p: ChatProvider): Promise<ChatDelta[]> {
  const out: ChatDelta[] = []
  for await (const d of p.chat({ model: 'm', messages: [] }, new AbortController().signal)) {
    out.push(d)
  }
  return out
}

describe('ThinkNormalizingProvider', () => {
  it('纯文本逐字流式:正文必须完整透传', async () => {
    const src = '你好,我是助手'
    const deltas: ChatDelta[] = src.split('').map((c) => ({ type: 'text', text: c }))
    deltas.push({ type: 'done', finishReason: 'stop' })
    const out = await collect(new ThinkNormalizingProvider(fakeProvider(deltas)))
    const text = out.filter((d) => d.type === 'text').map((d) => (d as { text: string }).text).join('')
    expect(text).toBe(src)
  })

  it('含 think 标签:正文剥离标签,思考进 reasoning', async () => {
    const deltas: ChatDelta[] = [
      { type: 'text', text: '<think>分析一下' },
      { type: 'text', text: '问题</think>最终答案' },
      { type: 'done', finishReason: 'stop' }
    ]
    const out = await collect(new ThinkNormalizingProvider(fakeProvider(deltas)))
    const text = out.filter((d) => d.type === 'text').map((d) => (d as { text: string }).text).join('')
    const reasoning = out.filter((d) => d.type === 'reasoning').map((d) => (d as { text: string }).text).join('')
    expect(text).toBe('最终答案')
    expect(reasoning).toBe('分析一下问题')
  })

  it('done 之前必须 flush:末尾文本不能丢', async () => {
    const deltas: ChatDelta[] = [
      { type: 'text', text: '答案是42' },
      { type: 'done', finishReason: 'stop' }
    ]
    const out = await collect(new ThinkNormalizingProvider(fakeProvider(deltas)))
    const text = out.filter((d) => d.type === 'text').map((d) => (d as { text: string }).text).join('')
    expect(text).toBe('答案是42')
  })

  it('usage/done 顺序:正文 + usage 都在', async () => {
    const deltas: ChatDelta[] = [
      { type: 'text', text: '回复内容' },
      { type: 'usage', promptTokens: 10, completionTokens: 5 },
      { type: 'done', finishReason: 'stop' }
    ]
    const out = await collect(new ThinkNormalizingProvider(fakeProvider(deltas)))
    const text = out.filter((d) => d.type === 'text').map((d) => (d as { text: string }).text).join('')
    expect(text).toBe('回复内容')
    expect(out.some((d) => d.type === 'usage')).toBe(true)
  })

  it('error delta 透传', async () => {
    const deltas: ChatDelta[] = [{ type: 'error', message: 'boom' }]
    const out = await collect(new ThinkNormalizingProvider(fakeProvider(deltas)))
    expect(out).toEqual([{ type: 'error', message: 'boom' }])
  })
})
