import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../migrations'

let db: Database.Database
beforeEach(() => {
  db = new Database(':memory:')
  runMigrations(db)
})

describe('migration v5 记忆表', () => {
  it('user_version 升到 5', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(5)
  })
  it('建出四张记忆相关表', () => {
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name)
    expect(names).toContain('personal_memory')
    expect(names).toContain('personal_memory_fts')
    expect(names).toContain('memory_links')
    expect(names).toContain('memory_episodes')
  })
  it('FTS 触发器随主表插入同步', () => {
    db.prepare(
      `INSERT INTO personal_memory
        (content, mem_type, tier, importance, confidence, access_count, created_at, updated_at, fts_content)
       VALUES ('记忆正文', 'user', 'semantic', 8, 0.7, 0, 0, 0, '记 忆')`
    ).run()
    const hit = db.prepare(`SELECT rowid FROM personal_memory_fts WHERE personal_memory_fts MATCH '记'`).all()
    expect(hit.length).toBe(1)
  })
})
