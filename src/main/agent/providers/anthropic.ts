// src/main/agent/providers/anthropic.ts
import { parseSSE } from './sse'
import type { ChatProvider, ChatRequest, ChatDelta, ProviderCredentials, ChatMessage } from './types'

/** Anthropic 原生 Messages 协议 provider */
export class AnthropicProvider implements ChatProvider {
  constructor(
    public readonly name: string,
    private creds: ProviderCredentials,
    private fetchImpl: typeof fetch = globalThis.fetch
  ) {}

  async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatDelta> {
    const url = `${this.creds.baseUrl.replace(/\/+$/, '')}/v1/messages`
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n')
    const body = {
      model: req.model,
      stream: true,
      max_tokens: req.maxTokens ?? 4096,
      ...(system ? { system } : {}),
      messages: req.messages.filter((m) => m.role !== 'system').map(toAnthropicMessage),
      ...(req.tools?.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
      ...(req.temperature != null ? { temperature: req.temperature } : {})
    }
    let resp: Response
    try {
      resp = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.creds.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
        signal
      })
    } catch (e) {
      yield { type: 'error', message: `请求失败: ${(e as Error).message}` }
      return
    }
    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '')
      yield { type: 'error', message: `HTTP ${resp.status}: ${text.slice(0, 500)}` }
      return
    }
    for await (const raw of parseSSE(resp.body, signal)) {
      let ev: AnthropicEvent
      try {
        ev = JSON.parse(raw)
      } catch {
        continue
      }
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
        yield { type: 'tool_call', index: ev.index ?? 0, id: ev.content_block.id, name: ev.content_block.name }
      } else if (ev.type === 'content_block_delta') {
        const d = ev.delta
        if (d?.type === 'text_delta' && d.text) yield { type: 'text', text: d.text }
        else if (d?.type === 'thinking_delta' && d.thinking) yield { type: 'reasoning', text: d.thinking }
        else if (d?.type === 'input_json_delta' && d.partial_json != null) yield { type: 'tool_call', index: ev.index ?? 0, argumentsDelta: d.partial_json }
      } else if (ev.type === 'message_delta' && ev.delta?.stop_reason) {
        yield { type: 'done', finishReason: ev.delta.stop_reason }
      } else if (ev.type === 'message_start' && ev.message?.usage) {
        yield { type: 'usage', promptTokens: ev.message.usage.input_tokens }
      }
    }
  }
}

interface AnthropicEvent {
  type: string
  index?: number
  content_block?: { type?: string; id?: string; name?: string }
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string }
  message?: { usage?: { input_tokens?: number } }
}

function toAnthropicMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }] }
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    const blocks: Record<string, unknown>[] = []
    if (m.content) blocks.push({ type: 'text', text: m.content })
    for (const tc of m.toolCalls) {
      let input: unknown
      try {
        input = JSON.parse(tc.arguments || '{}')
      } catch {
        input = {}
      }
      blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input })
    }
    return { role: 'assistant', content: blocks }
  }
  return { role: m.role, content: m.content }
}
