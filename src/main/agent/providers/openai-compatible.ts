// src/main/agent/providers/openai-compatible.ts
import { parseSSE } from './sse'
import type { ChatProvider, ChatRequest, ChatDelta, ProviderCredentials, ChatMessage, ToolSchema } from './types'

/** OpenAI 兼容协议 provider,覆盖绝大多数国内外厂商 */
export class OpenAICompatProvider implements ChatProvider {
  constructor(
    public readonly name: string,
    private creds: ProviderCredentials,
    private fetchImpl: typeof fetch = globalThis.fetch
  ) {}

  async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatDelta> {
    const url = `${this.creds.baseUrl.replace(/\/+$/, '')}/chat/completions`
    const body = {
      model: req.model,
      messages: req.messages.map(toOpenAIMessage),
      stream: true,
      stream_options: { include_usage: true },
      ...(req.tools?.length ? { tools: req.tools.map(toOpenAITool) } : {}),
      ...(req.temperature != null ? { temperature: req.temperature } : {}),
      ...(req.maxTokens != null ? { max_tokens: req.maxTokens } : {})
    }
    let resp: Response
    try {
      resp = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.creds.apiKey}` },
        body: JSON.stringify(body),
        signal
      })
    } catch (e) {
      // fetch 失败时原始网络原因藏在 cause 里(超时/DNS/证书),透出便于排查
      const err = e as Error & { cause?: unknown }
      const cause = err.cause instanceof Error ? err.cause.message : ''
      yield { type: 'error', message: `请求失败: ${err.message}${cause ? ` (${cause})` : ''}` }
      return
    }
    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '')
      yield { type: 'error', message: `HTTP ${resp.status}: ${text.slice(0, 500)}` }
      return
    }
    for await (const raw of parseSSE(resp.body, signal)) {
      let chunk: OpenAIChunk
      try {
        chunk = JSON.parse(raw)
      } catch {
        continue
      }
      const choice = chunk.choices?.[0]
      const delta = choice?.delta
      if (delta?.reasoning_content) yield { type: 'reasoning', text: delta.reasoning_content }
      if (delta?.content) yield { type: 'text', text: delta.content }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          yield { type: 'tool_call', index: tc.index ?? 0, id: tc.id, name: tc.function?.name, argumentsDelta: tc.function?.arguments }
        }
      }
      if (chunk.usage) yield { type: 'usage', promptTokens: chunk.usage.prompt_tokens, completionTokens: chunk.usage.completion_tokens }
      if (choice?.finish_reason) yield { type: 'done', finishReason: choice.finish_reason }
    }
  }
}

interface OpenAIChunk {
  choices?: Array<{
    delta?: {
      content?: string
      reasoning_content?: string
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
    }
    finish_reason?: string
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

function toOpenAIMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') return { role: 'tool', content: m.content, tool_call_id: m.toolCallId, name: m.name }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }))
    }
  }
  return { role: m.role, content: m.content }
}

function toOpenAITool(t: ToolSchema): Record<string, unknown> {
  return { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }
}
