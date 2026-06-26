// src/renderer/src/services/agent/memory.ts
// P6 sweep: 改走 window.api.agentMemory IPC,Python HTTP 后端已下线

/** stats 返回的统计形状(对齐主进程 metacognition MemoryStats) */
export interface MemoryStats {
  total: number
  byTier: Record<'semantic' | 'procedural' | 'archival', number>
  byType: Record<'user' | 'environment' | 'procedural', number>
  avgConfidence: number
  linkCount: number
  episodeCount: number
  unconsolidatedCount: number
}

/** 对外暴露的领域记录(P3 真实字段;历史 snake_case 形式已停) */
export interface MemoryEntry {
  id: number
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
  supersededBy: number | null
}

export interface MemoryListResponse {
  entries: MemoryEntry[]
  total: number
}

export interface MemorySearchResponse {
  results: Array<{ entry: MemoryEntry; score: number }>
}

function rawRecordToEntry(rec: Record<string, unknown>): MemoryEntry {
  return rec as unknown as MemoryEntry
}

export const memoryAPI = {
  list: async (params?: { type?: string; tier?: string; offset?: number; limit?: number }): Promise<MemoryListResponse> => {
    const limit = params?.limit ?? 100
    const offset = params?.offset ?? 0
    const records = (await window.api.agentMemory.list({ limit, offset })) as Array<Record<string, unknown>>
    let entries = records.map(rawRecordToEntry)
    if (params?.type) entries = entries.filter((e) => e.memType === params.type)
    if (params?.tier) entries = entries.filter((e) => e.tier === params.tier)
    return { entries, total: entries.length }
  },

  stats: (): Promise<MemoryStats> => window.api.agentMemory.stats(),

  get: (id: number | string): Promise<MemoryEntry | null> => {
    const numId = typeof id === 'string' ? Number(id) : id
    return window.api.agentMemory.get(numId).then((r) => (r ? rawRecordToEntry(r.record) : null))
  },

  update: (id: number | string, data: { content?: string; tags?: string[]; importance?: number; keywords?: string[]; contextDesc?: string }): Promise<{ success: boolean }> => {
    const numId = typeof id === 'string' ? Number(id) : id
    return window.api.agentMemory.update(numId, data)
  },

  delete: (id: number | string): Promise<{ success: boolean }> => {
    const numId = typeof id === 'string' ? Number(id) : id
    return window.api.agentMemory.delete(numId)
  },

  search: async (query: string, opts?: { limit?: number }): Promise<MemorySearchResponse> => {
    const records = (await window.api.agentMemory.search({ query, topK: opts?.limit ?? 8 })) as Array<Record<string, unknown>>
    return {
      results: records.map((rec) => ({
        entry: rawRecordToEntry(rec),
        score: (rec.score as number) ?? 0
      }))
    }
  }
}
