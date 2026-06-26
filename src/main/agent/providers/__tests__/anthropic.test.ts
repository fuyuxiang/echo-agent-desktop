import { describe, it, expect } from 'vitest'
import { AnthropicProvider } from '../anthropic'
import type { ChatDelta } from '../types'

const enc = new TextEncoder()
function sseResponse(events: object[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`))
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

describe('AnthropicProvider', () => {
  it('解析文本增量', async () => {
    const fetchMock = (async () =>
      sseResponse([
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
      ])) as unknown as typeof fetch
    const p = new AnthropicProvider('anthropic', { apiKey: 'k', baseUrl: 'https://api.anthropic.com' }, fetchMock)
    const deltas = await collect(p.chat({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal))
    expect(deltas.find((d) => d.type === 'text')).toEqual({ type: 'text', text: 'Hi' })
    expect(deltas.some((d) => d.type === 'done')).toBe(true)
  })

  it('thinking_delta 映射 reasoning', async () => {
    const fetchMock = (async () =>
      sseResponse([{ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '想' } }])) as unknown as typeof fetch
    const p = new AnthropicProvider('anthropic', { apiKey: 'k', baseUrl: 'https://api.anthropic.com' }, fetchMock)
    const deltas = await collect(p.chat({ model: 'claude-x', messages: [] }, new AbortController().signal))
    expect(deltas.find((d) => d.type === 'reasoning')).toEqual({ type: 'reasoning', text: '想' })
  })

  it('tool_use 映射 tool_call', async () => {
    const fetchMock = (async () =>
      sseResponse([
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'shell' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"cmd":"ls"}' } }
      ])) as unknown as typeof fetch
    const p = new AnthropicProvider('anthropic', { apiKey: 'k', baseUrl: 'https://api.anthropic.com' }, fetchMock)
    const tcs = (await collect(p.chat({ model: 'claude-x', messages: [] }, new AbortController().signal))).filter((d) => d.type === 'tool_call')
    expect(tcs[0]).toMatchObject({ index: 0, id: 'tu_1', name: 'shell' })
    expect(tcs[1]).toMatchObject({ index: 0, argumentsDelta: '{"cmd":"ls"}' })
  })

  it('非 2xx 吐 error', async () => {
    const fetchMock = (async () => new Response('bad', { status: 400 })) as unknown as typeof fetch
    const p = new AnthropicProvider('anthropic', { apiKey: 'k', baseUrl: 'https://api.anthropic.com' }, fetchMock)
    expect((await collect(p.chat({ model: 'm', messages: [] }, new AbortController().signal))).some((d) => d.type === 'error')).toBe(true)
  })
})
