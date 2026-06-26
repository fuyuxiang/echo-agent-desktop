// src/main/agent/providers/__tests__/openai-compatible.test.ts
import { describe, it, expect } from 'vitest'
import { OpenAICompatProvider } from '../openai-compatible'
import type { ChatDelta } from '../types'

const enc = new TextEncoder()
function sseResponse(lines: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(`data: ${l}\n\n`))
      c.enqueue(enc.encode('data: [DONE]\n\n'))
      c.close()
    }
  })
  return new Response(stream, { status: 200 })
}
async function collect(it: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const out: ChatDelta[] = []
  for await (const d of it) out.push(d)
  return out
}

describe('OpenAICompatProvider', () => {
  it('解析文本增量与结束', async () => {
    const fetchMock = (async () =>
      sseResponse([
        JSON.stringify({ choices: [{ delta: { content: '你' } }] }),
        JSON.stringify({ choices: [{ delta: { content: '好' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })
      ])) as unknown as typeof fetch
    const p = new OpenAICompatProvider('deepseek', { apiKey: 'k', baseUrl: 'https://x/v1' }, fetchMock)
    const deltas = await collect(p.chat({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal))
    const text = deltas.filter((d) => d.type === 'text').map((d) => (d as { text: string }).text).join('')
    expect(text).toBe('你好')
    expect(deltas.some((d) => d.type === 'done')).toBe(true)
  })

  it('映射 reasoning_content', async () => {
    const fetchMock = (async () => sseResponse([JSON.stringify({ choices: [{ delta: { reasoning_content: '推理中' } }] })])) as unknown as typeof fetch
    const p = new OpenAICompatProvider('deepseek', { apiKey: 'k', baseUrl: 'https://x/v1' }, fetchMock)
    const deltas = await collect(p.chat({ model: 'r', messages: [] }, new AbortController().signal))
    expect(deltas.find((d) => d.type === 'reasoning')).toEqual({ type: 'reasoning', text: '推理中' })
  })

  it('映射 tool_calls 增量', async () => {
    const fetchMock = (async () =>
      sseResponse([
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'shell', arguments: '{"cmd"' } }] } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"ls"}' } }] } }] })
      ])) as unknown as typeof fetch
    const p = new OpenAICompatProvider('x', { apiKey: 'k', baseUrl: 'https://x/v1' }, fetchMock)
    const tcs = (await collect(p.chat({ model: 'm', messages: [] }, new AbortController().signal))).filter((d) => d.type === 'tool_call')
    expect(tcs[0]).toMatchObject({ index: 0, id: 'call_1', name: 'shell', argumentsDelta: '{"cmd"' })
    expect(tcs[1]).toMatchObject({ index: 0, argumentsDelta: ':"ls"}' })
  })

  it('非 2xx 吐 error 而非抛异常', async () => {
    const fetchMock = (async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch
    const p = new OpenAICompatProvider('x', { apiKey: 'bad', baseUrl: 'https://x/v1' }, fetchMock)
    const deltas = await collect(p.chat({ model: 'm', messages: [] }, new AbortController().signal))
    expect(deltas.some((d) => d.type === 'error')).toBe(true)
  })
})
