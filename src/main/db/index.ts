import { join } from 'node:path'
import { app } from 'electron'
import Database from 'better-sqlite3'
import { log } from '../logger'
import { runMigrations } from './migrations'

/**
 * 本地数据库(better-sqlite3)
 *
 * - 数据库文件: userData/echo.db
 * - 同步 API,主进程内直接调用;渲染层通过 IPC -> DAO 访问
 * - schema 变更一律走 migrations,禁止直接改表
 */
let db: Database.Database | null = null

/** 初始化数据库连接并执行迁移(app ready 后调用) */
export function setupDatabase(): void {
  const dbPath = join(app.getPath('userData'), 'echo.db')
  db = new Database(dbPath)
  // WAL 模式:读写并发性能更好,桌面应用标配
  db.pragma('journal_mode = WAL')
  runMigrations(db)
  log.info('[db] 数据库就绪:', dbPath)
}

/** 获取数据库实例(DAO 层使用) */
export function getDb(): Database.Database {
  if (!db) throw new Error('[db] 数据库尚未初始化,请先调用 setupDatabase()')
  return db
}

/** 关闭数据库(应用退出前调用) */
export function closeDatabase(): void {
  db?.close()
  db = null
}
