import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../migrations'

let db: Database.Database
beforeEach(() => {
  db = new Database(':memory:')
  runMigrations(db)
})

describe('migration v3 meeting tables', () => {
  it('建出三张会议表', () => {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
      .map((r) => r.name)
    expect(names).toContain('meetings')
    expect(names).toContain('meeting_segments')
    expect(names).toContain('meeting_summaries')
  })
  it('user_version 升到 4', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(4)
  })
})
