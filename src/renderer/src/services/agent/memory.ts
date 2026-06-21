import { agentRequest } from './proxy-request'
import { AgentApiUrls } from '@/request/urls'
import { useAgentStore } from '@/stores/agentStore'

function getBaseUrl(): string {
  return useAgentStore.getState().baseUrl
}

export interface MemoryEntry {
  id: string
  content: string
  type: string
  tier: string
  tags: string[]
  created_at: string
  updated_at: string
}

export interface MemoryListResponse {
  entries: MemoryEntry[]
  total: number
}

export interface MemorySearchResponse {
  results: Array<{ entry: MemoryEntry; score?: number }>
}

export const memoryAPI = {
  list: (params?: { type?: string; tier?: string; offset?: number; limit?: number }) => {
    const qs = params
      ? '?' +
        new URLSearchParams(
          Object.entries(params)
            .filter(([, v]) => v != null)
            .map(([k, v]) => [k, String(v)])
        ).toString()
      : ''
    return agentRequest
      .get<MemoryListResponse>(`${getBaseUrl()}${AgentApiUrls.memory}${qs}`)
      .then((r) => r.data)
  },

  stats: () =>
    agentRequest
      .get<Record<string, unknown>>(`${getBaseUrl()}${AgentApiUrls.memoryStats}`)
      .then((r) => r.data),

  get: (id: string) =>
    agentRequest
      .get<MemoryEntry>(`${getBaseUrl()}${AgentApiUrls.memoryDetail(id)}`)
      .then((r) => r.data),

  update: (id: string, data: { content?: string; tags?: string[] }) =>
    agentRequest
      .post<MemoryEntry>(`${getBaseUrl()}${AgentApiUrls.memoryDetail(id)}`, data)
      .then((r) => r.data),

  delete: (id: string) =>
    agentRequest
      .delete<{ success?: boolean }>(`${getBaseUrl()}${AgentApiUrls.memoryDetail(id)}`)
      .then((r) => r.data),

  search: (query: string, opts?: { type?: string; limit?: number }) =>
    agentRequest
      .post<MemorySearchResponse>(`${getBaseUrl()}${AgentApiUrls.memorySearch}`, { query, ...opts })
      .then((r) => r.data)
}
