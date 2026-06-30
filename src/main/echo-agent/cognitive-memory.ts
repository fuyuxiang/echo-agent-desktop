import type { EchoAgentEndpoint } from './types'

export interface CognitiveEntry {
  id: string
  content: string
  tags: string[]
  importance: number
}

export function parseListResponse(json: unknown): CognitiveEntry[] {
  if (!json || typeof json !== 'object') return []
  const entries = (json as { entries?: unknown }).entries
  if (!Array.isArray(entries)) return []
  return entries.map((raw) => {
    const e = (raw ?? {}) as Record<string, unknown>
    return {
      id: String(e.id ?? ''),
      content: typeof e.content === 'string' ? e.content : '',
      tags: Array.isArray(e.tags) ? (e.tags as string[]) : [],
      importance: typeof e.importance === 'number' ? e.importance : 0
    }
  })
}

export async function listCognitiveMemory(
  endpoint: EchoAgentEndpoint,
  limit = 200
): Promise<CognitiveEntry[]> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 5000)
  try {
    const res = await fetch(`${endpoint.baseUrl}/api/memory?limit=${limit}`, {
      headers: { Authorization: `Bearer ${endpoint.token}` },
      signal: ctrl.signal
    })
    if (!res.ok) return []
    return parseListResponse(await res.json())
  } catch {
    return []
  } finally {
    clearTimeout(t)
  }
}
