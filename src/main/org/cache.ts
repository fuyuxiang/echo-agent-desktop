import type Database from 'better-sqlite3'
import type { RetrieveResult, RetrievedChunk } from '@shared/types/org'

/**
 * L2/L3 知识的本地只读缓存 + 待提交队列。
 *
 * 缓存存在的意义是断网可用:出差、内网隔离、服务器维护时,组织知识仍能答上
 * 常见问题。它是只读镜像 —— 本地改动从不回写,冲突问题不存在。
 *
 * 中文检索用 bigram 补偿:FTS5 的 unicode61 把 CJK 按单字切,"报销审批"会
 * 被切成四个字,查"报销"会命中所有含"报"或"销"的内容。写入时额外存 bigram
 * 副本,查询时同样 bigram 化。
 */

export function migrateOrgCache(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS org_kb_cache (
      chunk_id     TEXT PRIMARY KEY,
      doc_id       TEXT NOT NULL,
      title        TEXT NOT NULL,
      text         TEXT NOT NULL,
      heading      TEXT,
      loc_page     INTEGER,
      loc_start_ms INTEGER,
      scope_kind   TEXT NOT NULL DEFAULT 'org',
      modality     TEXT NOT NULL DEFAULT 'text',
      updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_org_cache_doc ON org_kb_cache(doc_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS org_kb_fts USING fts5(
      body, content='', tokenize='unicode61'
    );

    -- FTS5 是 contentless 表,rowid 与 chunk 的对应关系需自行维护。
    CREATE TABLE IF NOT EXISTS org_kb_fts_map (
      chunk_id  TEXT PRIMARY KEY,
      fts_rowid INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS org_memory_cache (
      id         TEXT PRIMARY KEY,
      kind       TEXT NOT NULL,
      content    TEXT NOT NULL,
      scope_kind TEXT NOT NULL DEFAULT 'org',
      updated_at INTEGER NOT NULL
    );

    -- 离线时提交的知识先落这里,联网后补提。丢掉它等于让用户白写一遍。
    CREATE TABLE IF NOT EXISTS org_pending_promotions (
      id           TEXT PRIMARY KEY,
      payload_type TEXT NOT NULL,
      payload      TEXT NOT NULL,
      source       TEXT NOT NULL,
      target_scope TEXT NOT NULL,
      state        TEXT NOT NULL DEFAULT 'local',
      last_error   TEXT,
      created_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS org_sync_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
}

const CJK = /[一-鿿㐀-䶿]/

export function toBigrams(text: string): string {
  const out: string[] = []
  let cjkRun: string[] = []
  let asciiRun: string[] = []

  const flushCjk = (): void => {
    if (cjkRun.length === 0) return
    const s = cjkRun.join('')
    if (s.length === 1) out.push(s)
    else for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2))
    cjkRun = []
  }
  // ASCII 连续段整体保留:型号(XR2000)、缩写(OA)、工号靠精确匹配命中,
  // 逐字符拆开会让它们彻底查不到。
  const flushAscii = (): void => {
    if (asciiRun.length === 0) return
    out.push(asciiRun.join(''))
    asciiRun = []
  }

  for (const ch of text) {
    if (CJK.test(ch)) {
      flushAscii()
      cjkRun.push(ch)
    } else if (/[A-Za-z0-9_]/.test(ch)) {
      flushCjk()
      asciiRun.push(ch)
    } else {
      flushCjk()
      flushAscii()
    }
  }
  flushCjk()
  flushAscii()
  return out.join(' ')
}

/** FTS5 特殊字符不转义会让用户输入的引号变成语法,导致查询报错。 */
export function buildMatch(query: string): string {
  const cleaned = query.replace(/["*():^-]/g, ' ').trim()
  if (!cleaned) return ''
  const tokens = new Set<string>()
  for (const m of cleaned.matchAll(/[A-Za-z0-9_]+/g)) {
    if (m[0].length >= 2) tokens.add(m[0].toLowerCase())
  }
  for (const bg of toBigrams(cleaned).split(/\s+/)) {
    if (bg && CJK.test(bg)) tokens.add(bg)
  }
  if (tokens.size === 0) return ''
  return [...tokens].map((t) => `"${t}"`).join(' OR ')
}

export interface SyncPayload {
  docs: {
    docId: string
    title: string
    scopeKind: string
    updatedAt: number
    chunks: {
      chunkId: string
      text: string
      heading: string | null
      locPage: number | null
      locStartMs: number | null
      modality: string
    }[]
  }[]
  memories: { id: string; kind: string; content: string; scopeKind: string }[]
  revokedDocs: string[]
  revokedMemories?: string[]
  purgeAll: boolean
}

export class OrgCache {
  constructor(private db: Database.Database) {
    migrateOrgCache(db)
  }

  applySync(payload: SyncPayload, cursor: number): void {
    this.db.transaction(() => {
      // purgeAll:用户被禁用或移出所有分组,本地不该再留任何组织知识。
      if (payload.purgeAll) this.clearAll()

      for (const docId of payload.revokedDocs) this.removeDoc(docId)
      for (const memoryId of payload.revokedMemories ?? []) {
        this.db.prepare('DELETE FROM org_memory_cache WHERE id = ?').run(memoryId)
      }

      // 被收回的文档即使同批里还带着更新内容也不写入。服务端在密级提升这类
      // 场景下会同时出现在两个列表里(文档本身有更新、对该用户已不可见),
      // 只按顺序删再写会把刚收回的内容原样写回来。
      const revoked = new Set(payload.revokedDocs)

      for (const doc of payload.docs) {
        if (revoked.has(doc.docId)) continue
        this.removeDoc(doc.docId)
        for (const c of doc.chunks) {
          const info = this.db
            .prepare('INSERT INTO org_kb_fts(body) VALUES (?)')
            .run(`${c.text} ${toBigrams(c.text)}`)
          this.db
            .prepare(
              `INSERT INTO org_kb_cache
                 (chunk_id, doc_id, title, text, heading, loc_page, loc_start_ms,
                  scope_kind, modality, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)`
            )
            .run(
              c.chunkId,
              doc.docId,
              doc.title,
              c.text,
              c.heading,
              c.locPage,
              c.locStartMs,
              doc.scopeKind,
              c.modality,
              doc.updatedAt
            )
          this.db
            .prepare('INSERT INTO org_kb_fts_map (chunk_id, fts_rowid) VALUES (?,?)')
            .run(c.chunkId, Number(info.lastInsertRowid))
        }
      }

      for (const m of payload.memories) {
        this.db
          .prepare(
            `INSERT INTO org_memory_cache (id, kind, content, scope_kind, updated_at)
             VALUES (?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET
               kind=excluded.kind, content=excluded.content,
               scope_kind=excluded.scope_kind, updated_at=excluded.updated_at`
          )
          .run(m.id, m.kind, m.content, m.scopeKind, Date.now())
      }

      this.setState('cursor', String(cursor))
      this.setState('lastSyncAt', String(Date.now()))
    })()
  }

  private removeDoc(docId: string): void {
    const maps = this.db
      .prepare(
        `SELECT m.chunk_id AS chunkId, m.fts_rowid AS ftsRowid
           FROM org_kb_fts_map m
           JOIN org_kb_cache c ON c.chunk_id = m.chunk_id
          WHERE c.doc_id = ?`
      )
      .all(docId) as { chunkId: string; ftsRowid: number }[]
    for (const m of maps) {
      try {
        this.db
          .prepare("INSERT INTO org_kb_fts(org_kb_fts, rowid, body) VALUES('delete', ?, '')")
          .run(m.ftsRowid)
      } catch {
        // contentless 表删除失败不阻断:主表行删掉后 join 不上,残留行不会命中
      }
      this.db.prepare('DELETE FROM org_kb_fts_map WHERE chunk_id = ?').run(m.chunkId)
    }
    this.db.prepare('DELETE FROM org_kb_cache WHERE doc_id = ?').run(docId)
  }

  clearAll(): void {
    this.db.exec(`
      DELETE FROM org_kb_cache;
      DELETE FROM org_kb_fts_map;
      DELETE FROM org_memory_cache;
    `)
    // contentless FTS5 表不接受 DELETE FROM,必须用 'delete-all' 命令。
    // 用 exec 会在登出路径上抛异常,导致上一个人的缓存留在机器上。
    this.db.prepare("INSERT INTO org_kb_fts(org_kb_fts) VALUES('delete-all')").run()
    this.setState('cursor', '0')
  }

  search(query: string, limit = 8, scopes?: Array<'org' | 'team'>): RetrieveResult {
    const match = buildMatch(query)
    const empty: RetrieveResult = {
      chunks: [],
      memories: [],
      diagnostics: {
        bm25Hits: 0,
        vecHits: 0,
        fusedCandidates: 0,
        rerankMs: 0,
        rerankSkipped: true,
        totalMs: 0
      },
      fromCache: true
    }
    if (!match) return empty

    const rows: Record<string, unknown>[] = (() => {
      try {
        const scopeClause = scopes?.length
          ? ` AND c.scope_kind IN (${scopes.map(() => '?').join(',')})`
          : ''
        return this.db
          .prepare(
            `SELECT c.chunk_id AS chunkId, c.doc_id AS docId, c.title AS docTitle,
                    c.text, c.heading, c.loc_page AS locPage, c.loc_start_ms AS locStartMs,
                    c.scope_kind AS scopeKind, c.modality, c.updated_at AS updatedAt,
                    bm25(org_kb_fts) AS rank
               FROM org_kb_fts
               JOIN org_kb_fts_map m ON m.fts_rowid = org_kb_fts.rowid
               JOIN org_kb_cache c ON c.chunk_id = m.chunk_id
              WHERE org_kb_fts MATCH ?${scopeClause}
              ORDER BY rank
              LIMIT ?`
          )
          .all(match, ...(scopes ?? []), limit) as Record<string, unknown>[]
      } catch {
        // 缓存损坏不该让对话失败
        return []
      }
    })()

    const chunks: RetrievedChunk[] = rows.map((r) => ({
      chunkId: String(r.chunkId),
      docId: String(r.docId),
      docTitle: String(r.docTitle),
      text: String(r.text),
      // bm25 返回负值,越小越相关。映射到 0..1 仅供展示排序,
      // 不可与在线的精排分数直接比较。
      score: 1 / (1 + Math.abs(Number(r.rank ?? 0))),
      scopeKind: (r.scopeKind === 'team' ? 'team' : 'org') as 'team' | 'org',
      modality: String(r.modality ?? 'text'),
      sourceType: 'cache',
      source: r.scopeKind === 'team' ? 'L2' : 'L3',
      citation: {
        page: r.locPage == null ? null : Number(r.locPage),
        heading: String(r.heading ?? ''),
        startMs: r.locStartMs == null ? null : Number(r.locStartMs),
        endMs: null,
        openUrl: `echo://doc/${String(r.docId)}`
      },
      owner: null,
      stale: false,
      updatedAt: Number(r.updatedAt ?? 0)
    }))

    const memRows = this.db
      .prepare(
        `SELECT id, kind, content, scope_kind AS scopeKind FROM org_memory_cache
          WHERE content LIKE ? LIMIT 5`
      )
      .all(`%${query.slice(0, 20)}%`) as Record<string, unknown>[]

    return {
      chunks,
      memories: memRows.map((m) => ({
        id: String(m.id),
        kind: String(m.kind),
        content: String(m.content),
        scopeKind: (m.scopeKind === 'team' ? 'team' : 'org') as 'team' | 'org',
        confidence: 0.8
      })),
      diagnostics: { ...empty.diagnostics, bm25Hits: chunks.length },
      fromCache: true
    }
  }

  stats(): { docs: number; chunks: number; lastSyncAt: number | null } {
    const chunks = (
      this.db.prepare('SELECT COUNT(*) AS n FROM org_kb_cache').get() as { n: number }
    ).n
    const docs = (
      this.db.prepare('SELECT COUNT(DISTINCT doc_id) AS n FROM org_kb_cache').get() as {
        n: number
      }
    ).n
    const last = this.getState('lastSyncAt')
    return { docs, chunks, lastSyncAt: last ? Number(last) : null }
  }

  getCursor(): number {
    return Number(this.getState('cursor') ?? '0')
  }

  getState(key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM org_sync_state WHERE key = ?')
      .get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  setState(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO org_sync_state (key, value) VALUES (?,?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value)
  }

  // ── 待提交队列 ──────────────────────────────────────────────────────────
  enqueuePromotion(row: {
    id: string
    payloadType: string
    payload: string
    source: string
    targetScope: string
  }): void {
    this.db
      .prepare(
        `INSERT INTO org_pending_promotions
           (id, payload_type, payload, source, target_scope, state, created_at)
         VALUES (?,?,?,?,?,'local',?)`
      )
      .run(row.id, row.payloadType, row.payload, row.source, row.targetScope, Date.now())
  }

  pendingPromotions(): {
    id: string
    payloadType: string
    payload: string
    source: string
    targetScope: string
    createdAt: number
    lastError: string | null
  }[] {
    return this.db
      .prepare(
        `SELECT id, payload_type AS payloadType, payload, source,
                target_scope AS targetScope, created_at AS createdAt, last_error AS lastError
           FROM org_pending_promotions WHERE state = 'local' ORDER BY created_at`
      )
      .all() as never
  }

  markPromotionSubmitted(id: string): void {
    this.db.prepare('DELETE FROM org_pending_promotions WHERE id = ?').run(id)
  }

  markPromotionFailed(id: string, error: string): void {
    this.db
      .prepare('UPDATE org_pending_promotions SET last_error = ? WHERE id = ?')
      .run(error.slice(0, 300), id)
  }
}
