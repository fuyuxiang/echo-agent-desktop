import type { ProjectMemory } from '@/services/server'

export interface MirrorRow {
  serverId: string
  content: string
  tags: string[]
  version: number
  updatedAt: number
}

export function mergeProjectMemory(
  local: MirrorRow[],
  server: ProjectMemory[]
): { upserts: MirrorRow[]; deletes: string[] } {
  const localById = new Map(local.map((r) => [r.serverId, r]))
  const serverIds = new Set(server.map((s) => s.id))
  const upserts: MirrorRow[] = []

  for (const s of server) {
    const existing = localById.get(s.id)
    if (existing && existing.updatedAt === s.updatedAt) continue // idempotent
    upserts.push({
      serverId: s.id,
      content: s.content,
      tags: s.tags,
      version: s.updatedAt,
      updatedAt: s.updatedAt
    })
  }

  const deletes = local.filter((r) => !serverIds.has(r.serverId)).map((r) => r.serverId)
  return { upserts, deletes }
}
