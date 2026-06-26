// src/main/agent/memory/metacognition.ts
import type Database from 'better-sqlite3'
import type { MemoryDao } from './dao'
import type { Provenance, MemTier, MemType } from './types'

export interface MemoryStats {
  total: number
  byTier: Record<MemTier, number>
  byType: Record<MemType, number>
  avgConfidence: number
  linkCount: number
  episodeCount: number
  unconsolidatedCount: number
}

export class Metacognition {
  constructor(private deps: { db: Database.Database; dao: MemoryDao }) {}

  provenanceOf(memoryId: number): Provenance | null {
    const rec = this.deps.dao.getMemory(memoryId)
    return rec?.provenance ?? null
  }

  stats(): MemoryStats {
    const db = this.deps.db
    const byTier: Record<MemTier, number> = { semantic: 0, procedural: 0, archival: 0 }
    const byType: Record<MemType, number> = { user: 0, environment: 0, procedural: 0 }
    const tierRows = db
      .prepare(`SELECT tier, COUNT(*) n FROM personal_memory WHERE superseded_by IS NULL GROUP BY tier`)
      .all() as Array<{ tier: MemTier; n: number }>
    for (const r of tierRows) byTier[r.tier] = r.n
    const typeRows = db
      .prepare(`SELECT mem_type t, COUNT(*) n FROM personal_memory WHERE superseded_by IS NULL GROUP BY mem_type`)
      .all() as Array<{ t: MemType; n: number }>
    for (const r of typeRows) byType[r.t] = r.n
    const agg = db
      .prepare(`SELECT COUNT(*) total, AVG(confidence) avg FROM personal_memory WHERE superseded_by IS NULL`)
      .get() as { total: number; avg: number | null }
    const linkCount = (db.prepare(`SELECT COUNT(*) n FROM memory_links`).get() as { n: number }).n
    const episodeCount = (db.prepare(`SELECT COUNT(*) n FROM memory_episodes`).get() as { n: number }).n
    const unconsolidatedCount = (
      db.prepare(`SELECT COUNT(*) n FROM memory_episodes WHERE consolidated=0`).get() as { n: number }
    ).n
    return {
      total: agg.total,
      byTier,
      byType,
      avgConfidence: agg.avg ?? 0,
      linkCount,
      episodeCount,
      unconsolidatedCount
    }
  }
}
