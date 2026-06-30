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
  },
  {
    version: 3,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS meetings (
          id            TEXT PRIMARY KEY,
          title         TEXT,
          started_at    INTEGER NOT NULL,
          ended_at      INTEGER,
          duration_ms   INTEGER NOT NULL DEFAULT 0,
          audio_path    TEXT,
          audio_source  TEXT NOT NULL DEFAULT 'mic',
          status        TEXT NOT NULL DEFAULT 'recording',
          created_at    INTEGER NOT NULL
        )
      `)
      db.exec(`
        CREATE TABLE IF NOT EXISTS meeting_segments (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          meeting_id  TEXT NOT NULL,
          idx         INTEGER NOT NULL,
          start_ms    INTEGER NOT NULL,
          end_ms      INTEGER NOT NULL,
          text        TEXT NOT NULL,
          speaker     TEXT,
          created_at  INTEGER NOT NULL
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_meeting_segments ON meeting_segments(meeting_id, idx)`)
      db.exec(`
        CREATE TABLE IF NOT EXISTS meeting_summaries (
          meeting_id   TEXT PRIMARY KEY,
          summary      TEXT NOT NULL,
          key_points   TEXT,
          action_items TEXT,
          model        TEXT,
          created_at   INTEGER NOT NULL
        )
      `)
    }
  },
  {
    version: 4,
    up: (db) => {
      // chat_messages 增加工具轨迹三列(承载 assistant.toolCalls / tool.toolCallId+toolName)
      db.exec(`
        ALTER TABLE chat_messages ADD COLUMN tool_calls TEXT;
        ALTER TABLE chat_messages ADD COLUMN tool_call_id TEXT;
        ALTER TABLE chat_messages ADD COLUMN tool_name TEXT;
      `)
    }
  },
  {
    version: 5,
    up: (db) => {
      // 认知记忆系统四表:personal_memory(主表) + personal_memory_fts(FTS5 外部内容) +
      // memory_links(Zettelkasten 链接网络) + memory_episodes(情景记忆)
      db.exec(`
        CREATE TABLE IF NOT EXISTS personal_memory (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          content       TEXT NOT NULL,
          fts_content   TEXT NOT NULL DEFAULT '',
          mem_type      TEXT NOT NULL,
          tier          TEXT NOT NULL,
          keywords      TEXT,
          tags          TEXT,
          context_desc  TEXT,
          importance    REAL NOT NULL,
          confidence    REAL NOT NULL DEFAULT 0.7,
          salience      REAL,
          provenance    TEXT,
          embedding     BLOB,
          access_count  INTEGER NOT NULL DEFAULT 0,
          last_access   INTEGER,
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL,
          superseded_by INTEGER
        )
      `)
      // FTS5 外部内容表:索引 personal_memory.fts_content 列,触发器保持同步
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS personal_memory_fts USING fts5(
          fts_content,
          content='personal_memory',
          content_rowid='id',
          tokenize='unicode61'
        )
      `)
      // FTS 同步触发器(外部内容表标准三件套:AI 插入 / AD 删除 / AU 更新)
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS personal_memory_ai AFTER INSERT ON personal_memory BEGIN
          INSERT INTO personal_memory_fts(rowid, fts_content) VALUES (new.id, new.fts_content);
        END
      `)
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS personal_memory_ad AFTER DELETE ON personal_memory BEGIN
          INSERT INTO personal_memory_fts(personal_memory_fts, rowid, fts_content)
          VALUES ('delete', old.id, old.fts_content);
        END
      `)
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS personal_memory_au AFTER UPDATE ON personal_memory BEGIN
          INSERT INTO personal_memory_fts(personal_memory_fts, rowid, fts_content)
          VALUES ('delete', old.id, old.fts_content);
          INSERT INTO personal_memory_fts(rowid, fts_content) VALUES (new.id, new.fts_content);
        END
      `)
      // A-MEM 风格的 Zettelkasten 链接网络(主键三元组,支持多种关系)
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_links (
          from_id    INTEGER NOT NULL,
          to_id      INTEGER NOT NULL,
          relation   TEXT NOT NULL,
          weight     REAL NOT NULL DEFAULT 1.0,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (from_id, to_id, relation)
        )
      `)
      // 情景记忆(按会话+时间窗组织的事件片段,可被合并到 personal_memory)
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_episodes (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          content       TEXT NOT NULL,
          entities      TEXT,
          session_key   TEXT NOT NULL,
          message_range TEXT,
          importance    REAL,
          consolidated  INTEGER NOT NULL DEFAULT 0,
          ts            INTEGER NOT NULL
        )
      `)
      // 索引:加速按层级/归档状态/最近访问的常用查询
      db.exec(`CREATE INDEX IF NOT EXISTS idx_episodes_consolidated ON memory_episodes(consolidated, ts)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_tier ON personal_memory(tier, superseded_by)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_access ON personal_memory(last_access)`)
    }
  },
  {
    version: 6,
    up: (db) => {
      // 项目记忆本地镜像:下行同步落地,serverId 主键 + version 幂等去重
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_memory_mirror (
          server_id   TEXT PRIMARY KEY,
          content     TEXT NOT NULL,
          tags        TEXT NOT NULL DEFAULT '[]',
          version     INTEGER NOT NULL DEFAULT 0,
          updated_at  INTEGER NOT NULL DEFAULT 0
        );
      `)
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
