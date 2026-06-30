// src/main/db/dao/project-memory.ts
export interface DbLike {
  prepare(sql: string): {
    run(...a: unknown[]): unknown
    get(...a: unknown[]): unknown
    all(...a: unknown[]): unknown[]
  }
}

export interface MirrorRecord {
  serverId: string
  content: string
  tags: string[]
  version: number
  updatedAt: number
}

export function upsertMirror(db: DbLike, row: MirrorRecord): void {
  db.prepare(
    `INSERT INTO project_memory_mirror (server_id, content, tags, version, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(server_id) DO UPDATE SET
       content = excluded.content,
       tags = excluded.tags,
       version = excluded.version,
       updated_at = excluded.updated_at`
  ).run(row.serverId, row.content, JSON.stringify(row.tags), row.version, row.updatedAt)
}

export function listMirror(db: DbLike): MirrorRecord[] {
  const rows = db.prepare('SELECT * FROM project_memory_mirror').all() as Array<Record<string, unknown>>
  return rows.map((r) => ({
    serverId: String(r.server_id),
    content: String(r.content ?? ''),
    tags: JSON.parse(String(r.tags ?? '[]')) as string[],
    version: Number(r.version ?? 0),
    updatedAt: Number(r.updated_at ?? 0)
  }))
}

export function deleteMirrorByServerId(db: DbLike, serverId: string): void {
  db.prepare('DELETE FROM project_memory_mirror WHERE server_id = ?').run(serverId)
}
