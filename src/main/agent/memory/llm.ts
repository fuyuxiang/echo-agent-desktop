// src/main/agent/memory/llm.ts
import type { ChatProvider, ChatMessage } from '../providers'

const DEFAULT_TIMEOUT_MS = 20_000

export interface MemoryLLM {
  complete(prompt: string, opts?: { timeoutMs?: number }): Promise<string | null>
}

export class ProviderMemoryLLM implements MemoryLLM {
  constructor(private deps: { provider: ChatProvider; model: string }) {}

  async complete(prompt: string, opts?: { timeoutMs?: number }): Promise<string | null> {
    const signal = AbortSignal.timeout(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const messages: ChatMessage[] = [{ role: 'user', content: prompt }]
    try {
      let out = ''
      for await (const d of this.deps.provider.chat({ model: this.deps.model, messages }, signal)) {
        if (d.type === 'text') out += d.text
      }
      return out
    } catch {
      return null
    }
  }
}

/** 剥 ```json 围栏后 JSON.parse,任何失败返回 null。 */
export function parseJsonLoose<T>(text: string | null): T | null {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = (fenced ? fenced[1] : text).trim()
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}
