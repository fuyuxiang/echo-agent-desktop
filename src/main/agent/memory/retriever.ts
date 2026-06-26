// src/main/agent/memory/retriever.ts
import type { MemoryDao } from './dao'
import { bigramText } from './text'
import type { MemoryRecord, ScoredMemory } from './types'

export interface RetrieveOpts {
  topK?: number
  weights?: { r: number; t: number; i: number }
  halfLifeHours?: number
  expandLinks?: boolean
}

const DEFAULTS = {
  topK: 8,
  weights: { r: 0.5, t: 0.3, i: 0.2 },
  halfLifeHours: 72,
  expandLinks: true
}

export class Retriever {
  constructor(private dao: MemoryDao) {}

  retrieve(query: string, opts?: RetrieveOpts): ScoredMemory[] {
    const o = { ...DEFAULTS, ...opts, weights: opts?.weights ?? DEFAULTS.weights }
    const candidates = this.dao.searchFts(bigramText(query), o.topK * 3)
    const now = Date.now()
    const scored = candidates.map((rec, idx) =>
      this.score(rec, idx, candidates.length, now, o.weights, o.halfLifeHours)
    )
    scored.sort((a, b) => b.score - a.score)
    const top = scored.slice(0, o.topK)
    const result = o.expandLinks ? this.expand(top, o.topK, now, o.weights, o.halfLifeHours) : top
    for (const s of result) this.dao.bumpAccess(s.record.id)
    return result
  }

  private score(
    rec: MemoryRecord,
    rank: number,
    total: number,
    now: number,
    w: { r: number; t: number; i: number },
    halfLife: number
  ): ScoredMemory {
    const relevance = total <= 1 ? 1 : 1 - rank / total
    const ts = rec.lastAccess ?? rec.createdAt
    const dtHours = Math.max(0, (now - ts) / 3_600_000)
    const recency = Math.exp((-Math.LN2 * dtHours) / halfLife)
    const importanceScore = Math.min(1, (rec.importance / 10) * (1 + Math.log1p(rec.accessCount) * 0.1))
    const base = w.r * relevance + w.t * recency + w.i * importanceScore
    return { record: rec, relevance, recency, importanceScore, score: base * rec.confidence }
  }

  private expand(
    top: ScoredMemory[],
    topK: number,
    now: number,
    w: { r: number; t: number; i: number },
    halfLife: number
  ): ScoredMemory[] {
    const seen = new Set(top.map((s) => s.record.id))
    const extra: ScoredMemory[] = []
    const cap = Math.floor(topK / 2)
    for (const s of top) {
      if (extra.length >= cap) break
      for (const link of this.dao.linksOf(s.record.id)) {
        const otherId = link.fromId === s.record.id ? link.toId : link.fromId
        if (seen.has(otherId)) continue
        const rec = this.dao.getMemory(otherId)
        if (!rec || rec.supersededBy !== null) continue
        seen.add(otherId)
        const scored = this.score(rec, 0, 1, now, w, halfLife)
        extra.push({ ...scored, score: scored.score * link.weight })
        if (extra.length >= cap) break
      }
    }
    return [...top, ...extra]
  }
}
