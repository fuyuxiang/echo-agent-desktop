import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations, LATEST_SCHEMA_VERSION } from '../migrations'

let db: Database.Database
beforeEach(() => {
  db = new Database(':memory:')
  runMigrations(db)
})

describe('migration v4 chat_messages 工具轨迹列', () => {
  it('user_version 升到最新 schema 版本', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION)
  })
  it('chat_messages 含 tool_calls/tool_call_id/tool_name 列', () => {
    const cols = (db.prepare("PRAGMA table_info(chat_messages)").all() as { name: string }[]).map(
      (c) => c.name
    )
    expect(cols).toContain('tool_calls')
    expect(cols).toContain('tool_call_id')
    expect(cols).toContain('tool_name')
  })
})
