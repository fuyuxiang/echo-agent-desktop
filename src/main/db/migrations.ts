import type Database from 'better-sqlite3'
import { log } from '../logger'

/**
 * 数据库迁移(版本号递增)
 *
 * 规则:
 * - 每次 schema 变更追加一个 { version, up },version 必须严格递增
 * - 已发布的迁移禁止修改,只能新增
 * - 当前版本记录在 SQLite 的 user_version pragma 中
 */
interface Migration {
  /** 目标版本号 */
  version: number
  /** 升级语句 */
  up: (db: Database.Database) => void
}

const migrations: Migration[] = [
  {
    version: 1,
    up: (db) => {
      // 示例表:配合 pages/Example 演示「渲染层 -> IPC -> DAO」全链路
      db.exec(`
        CREATE TABLE IF NOT EXISTS example_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `)
    }
  },
  {
    version: 2,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_sessions (
          chat_id       TEXT PRIMARY KEY,
          title         TEXT,
          platform      TEXT NOT NULL DEFAULT 'desktop',
          created_at    INTEGER NOT NULL,
          last_activity INTEGER NOT NULL,
          message_count INTEGER NOT NULL DEFAULT 0,
          pinned        INTEGER NOT NULL DEFAULT 0
        )
      `)
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_messages (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id    TEXT NOT NULL,
          role       TEXT NOT NULL,
          content    TEXT NOT NULL,
          reasoning  TEXT,
          created_at INTEGER NOT NULL
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_messages_chat ON chat_messages(chat_id, created_at)`)
    }
  }
]

/** 执行所有未应用的迁移 */
export function runMigrations(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number
  const pending = migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version)

  for (const migration of pending) {
    // 每个迁移在事务内执行,失败自动回滚
    db.transaction(() => {
      migration.up(db)
      db.pragma(`user_version = ${migration.version}`)
    })()
    log.info(`[db] 迁移完成 -> v${migration.version}`)
  }
}
