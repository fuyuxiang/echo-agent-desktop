// src/main/agent/memory/dao.ts
import type Database from 'better-sqlite3'
import { getDb } from '../../db'
import { bigramText } from './text'
import type {
  MemoryRecord,
  MemoryInput,
  Episode,
  EpisodeInput,
  MemoryLink,
  MemType,
  MemTier,
  Provenance
} from './types'

interface RawMemory {
  id: number
  content: string
  mem_type: string
  tier: string
  keywords: string | null
  tags: string | null
  context_desc: string | null
  importance: number
  confidence: number
  salience: number | null
  provenance: string | null
  access_count: number
  last_access: number | null
  created_at: number
  updated_at: number
  superseded_by: number | null
}

function parseArr(s: string | null): string[] {
  return s ? (JSON.parse(s) as string[]) : []
}

function toRecord(r: RawMemory): MemoryRecord {
  return {
    id: r.id,
    content: r.content,
    memType: r.mem_type as MemType,
    tier: r.tier as MemTier,
    keywords: parseArr(r.keywords),
    tags: parseArr(r.tags),
    contextDesc: r.context_desc ?? '',
    importance: r.importance,
    confidence: r.confidence,
    salience: r.salience,
    provenance: r.provenance ? (JSON.parse(r.provenance) as Provenance) : null,
    accessCount: r.access_count,
    lastAccess: r.last_access,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    supersededBy: r.superseded_by
  }
}

export class MemoryDao {
  private db: Database.Database
  constructor(db?: Database.Database) {
    this.db = db ?? getDb()
  }

  insertMemory(input: MemoryInput): MemoryRecord {
    const now = Date.now()
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO personal_memory
            (content, fts_content, mem_type, tier, keywords, tags, context_desc,
             importance, confidence, salience, provenance, access_count, last_access,
             created_at, updated_at, superseded_by)
           VALUES (@content,@fts,@memType,@tier,@keywords,@tags,@contextDesc,
             @importance,@confidence,@salience,@provenance,0,NULL,@now,@now,NULL)`
        )
        .run({
          content: input.content,
          fts: bigramText(input.content),
          memType: input.memType,
          tier: input.tier,
          keywords: JSON.stringify(input.keywords ?? []),
          tags: JSON.stringify(input.tags ?? []),
          contextDesc: input.contextDesc ?? '',
          importance: input.importance,
          confidence: input.confidence ?? 0.7,
          salience: input.salience ?? null,
          provenance: input.provenance ? JSON.stringify(input.provenance) : null,
          now
        }).lastInsertRowid
    )
    return this.getMemory(id)!
  }

  getMemory(id: number): MemoryRecord | undefined {
    const r = (this.db.prepare(`SELECT * FROM personal_memory WHERE id = ?`).get(id) as
      | RawMemory
      | undefined)
    return r ? toRecord(r) : undefined
  }

  updateMemory(id: number, patch: Partial<MemoryInput>): void {
    const cur = this.getMemory(id)
    if (!cur) return
    const content = patch.content ?? cur.content
    this.db
      .prepare(
        `UPDATE personal_memory SET
           content=@content, fts_content=@fts, importance=@importance,
           keywords=@keywords, tags=@tags, context_desc=@contextDesc, updated_at=@now
         WHERE id=@id`
      )
      .run({
        id,
        content,
        fts: bigramText(content),
        importance: patch.importance ?? cur.importance,
        keywords: JSON.stringify(patch.keywords ?? cur.keywords),
        tags: JSON.stringify(patch.tags ?? cur.tags),
        contextDesc: patch.contextDesc ?? cur.contextDesc,
        now: Date.now()
      })
  }

  supersede(oldId: number, newId: number): void {
    this.db.prepare(`UPDATE personal_memory SET superseded_by=? WHERE id=?`).run(newId, oldId)
  }

  softDelete(id: number): void {
    this.db.prepare(`UPDATE personal_memory SET superseded_by=id WHERE id=?`).run(id)
  }

  searchFts(queryBigram: string, limit: number): MemoryRecord[] {
    if (!queryBigram.trim()) return []
    const rows = this.db
      .prepare(
        `SELECT m.* FROM personal_memory_fts f
           JOIN personal_memory m ON m.id = f.rowid
         WHERE personal_memory_fts MATCH @q AND m.superseded_by IS NULL
         ORDER BY bm25(personal_memory_fts) ASC
         LIMIT @limit`
      )
      .all({ q: queryBigram, limit }) as RawMemory[]
    return rows.map(toRecord)
  }

  listSemantic(limit: number, offset: number): MemoryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM personal_memory
         WHERE superseded_by IS NULL AND tier != 'archival'
         ORDER BY updated_at DESC LIMIT ? OFFSET ?`
      )
      .all(limit, offset) as RawMemory[]
    return rows.map(toRecord)
  }

  bumpAccess(id: number): void {
    this.db
      .prepare(`UPDATE personal_memory SET access_count=access_count+1, last_access=? WHERE id=?`)
      .run(Date.now(), id)
  }

  demote(id: number): void {
    this.db.prepare(`UPDATE personal_memory SET tier='archival', updated_at=? WHERE id=?`).run(
      Date.now(),
      id
    )
  }

  setConfidence(id: number, confidence: number): void {
    this.db.prepare(`UPDATE personal_memory SET confidence=? WHERE id=?`).run(confidence, id)
  }

  insertEpisode(input: EpisodeInput): Episode {
    const ts = Date.now()
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO memory_episodes (content, entities, session_key, message_range, importance, consolidated, ts)
           VALUES (@content,@entities,@sessionKey,@range,@importance,0,@ts)`
        )
        .run({
          content: input.content,
          entities: JSON.stringify(input.entities ?? []),
          sessionKey: input.sessionKey,
          range: input.messageRange ? JSON.stringify(input.messageRange) : null,
          importance: input.importance ?? null,
          ts
        }).lastInsertRowid
    )
    return {
      id,
      content: input.content,
      entities: input.entities ?? [],
      sessionKey: input.sessionKey,
      messageRange: input.messageRange ?? null,
      importance: input.importance ?? null,
      consolidated: false,
      ts
    }
  }

  listUnconsolidated(limit: number): Episode[] {
    const rows = this.db
      .prepare(`SELECT * FROM memory_episodes WHERE consolidated=0 ORDER BY ts ASC LIMIT ?`)
      .all(limit) as Array<{
      id: number
      content: string
      entities: string | null
      session_key: string
      message_range: string | null
      importance: number | null
      consolidated: number
      ts: number
    }>
    return rows.map((r) => ({
      id: r.id,
      content: r.content,
      entities: r.entities ? (JSON.parse(r.entities) as string[]) : [],
      sessionKey: r.session_key,
      messageRange: r.message_range ? JSON.parse(r.message_range) : null,
      importance: r.importance,
      consolidated: r.consolidated === 1,
      ts: r.ts
    }))
  }

  markConsolidated(ids: number[]): void {
    const stmt = this.db.prepare(`UPDATE memory_episodes SET consolidated=1 WHERE id=?`)
    const tx = this.db.transaction((xs: number[]) => xs.forEach((x) => stmt.run(x)))
    tx(ids)
  }

  addLink(link: { fromId: number; toId: number; relation: string; weight: number }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO memory_links (from_id, to_id, relation, weight, created_at)
         VALUES (?,?,?,?,?)`
      )
      .run(link.fromId, link.toId, link.relation, link.weight, Date.now())
  }

  linksOf(id: number): MemoryLink[] {
    const rows = this.db
      .prepare(
        `SELECT from_id, to_id, relation, weight FROM memory_links WHERE from_id=? OR to_id=?`
      )
      .all(id, id) as Array<{ from_id: number; to_id: number; relation: string; weight: number }>
    return rows.map((r) => ({
      fromId: r.from_id,
      toId: r.to_id,
      relation: r.relation,
      weight: r.weight
    }))
  }
}
