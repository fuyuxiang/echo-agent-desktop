import { agentManagement } from './management'

export interface MemoryStats {
  total: number
  byTier: Record<string, number>
  byType: Record<string, number>
  avgConfidence?: number
  linkCount?: number
  episodeCount?: number
  unconsolidatedCount?: number
}

export interface MemoryEntry {
  id: string
  content: string
  memType: 'user' | 'environment' | 'procedural'
  tier: 'semantic' | 'procedural' | 'archival'
  keywords: string[]
  tags: string[]
  contextDesc: string
  importance: number
  confidence: number
  salience: number | null
  provenance: { sessionKey: string; messageIds: number[] } | null
  accessCount: number
  lastAccess: number | null
  createdAt: number
  updatedAt: number
  supersededBy: string | null
}

export interface MemoryListResponse {
  entries: MemoryEntry[]
  total: number
}

export interface MemorySearchResponse {
  results: Array<{ entry: MemoryEntry; score: number }>
}

type RawMemory = Record<string, unknown>

function timestamp(value: unknown): number {
  if (typeof value !== 'string' || !value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function fromAgent(raw: RawMemory): MemoryEntry {
  return {
    id: String(raw.id ?? ''),
    content: String(raw.content ?? ''),
    memType: (raw.type ?? 'user') as MemoryEntry['memType'],
    tier: (raw.tier ?? 'semantic') as MemoryEntry['tier'],
    keywords: [],
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    contextDesc: String(raw.key ?? ''),
    importance: Number(raw.importance ?? 0.5),
    confidence: 1,
    salience: null,
    provenance: null,
    accessCount: Number(raw.access_count ?? 0),
    lastAccess: timestamp(raw.last_accessed) || null,
    createdAt: timestamp(raw.created_at),
    updatedAt: timestamp(raw.updated_at),
    supersededBy: raw.superseded_by ? String(raw.superseded_by) : null
  }
}

export const memoryAPI = {
  list: async (params?: { type?: string; tier?: string; offset?: number; limit?: number }): Promise<MemoryListResponse> => {
    const query = new URLSearchParams({
      offset: String(params?.offset ?? 0),
      limit: String(params?.limit ?? 100)
    })
    if (params?.type) query.set('type', params.type)
    if (params?.tier) query.set('tier', params.tier)
    const result = await agentManagement<{ entries: RawMemory[]; total: number }>({
      method: 'GET', path: `/memory?${query}`
    })
    return { entries: result.entries.map(fromAgent), total: result.total }
  },

  stats: (): Promise<MemoryStats> =>
    agentManagement<{ total: number; by_tier: Record<string, number>; by_type: Record<string, number> }>({
      method: 'GET', path: '/memory/stats'
    }).then((r) => ({ total: r.total, byTier: r.by_tier, byType: r.by_type })),

  get: (id: number | string): Promise<MemoryEntry | null> =>
    agentManagement<RawMemory>({ method: 'GET', path: `/memory/${encodeURIComponent(String(id))}` })
      .then(fromAgent),

  update: (id: number | string, data: { content?: string; tags?: string[] }): Promise<{ success: boolean }> =>
    agentManagement({
      method: 'PUT',
      path: `/memory/${encodeURIComponent(String(id))}`,
      body: { ...data, override: true }
    }).then(() => ({ success: true })),

  delete: (id: number | string): Promise<{ success: boolean }> =>
    agentManagement({
      method: 'DELETE',
      path: `/memory/${encodeURIComponent(String(id))}?override=true`
    }).then(() => ({ success: true })),

  search: async (query: string, opts?: { limit?: number }): Promise<MemorySearchResponse> => {
    const result = await agentManagement<{ results: Array<{ entry: RawMemory; score: number }> }>({
      method: 'POST',
      path: '/memory/search',
      body: { query, limit: opts?.limit ?? 8, all_scopes: true }
    })
    return { results: result.results.map((r) => ({ entry: fromAgent(r.entry), score: r.score })) }
  }
}
