### Task 2: 数据库初始化与迁移

**Files:**
- Create: `src/db.ts`
- Test: `test/db.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `getDb(path?: string): Database`(打开并迁移到最新版本,加载 sqlite-vec);表 `users / groups / project_memories(+ vec 虚表) / model_configs`

- [ ] **Step 1: 写失败测试 test/db.test.ts**

```ts
import { describe, it, expect } from 'vitest'
import { getDb } from '../src/db.js'

describe('db migrations', () => {
  it('creates all tables on a fresh in-memory db', () => {
    const db = getDb(':memory:')
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name)
    expect(names).toEqual(expect.arrayContaining(['users', 'groups', 'project_memories', 'model_configs']))
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test test/db.test.ts`
Expected: FAIL,找不到 `src/db.js`

- [ ] **Step 3: 实现 src/db.ts**

```ts
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'

export type DB = Database.Database

const MIGRATIONS: ((db: DB) => void)[] = [
  (db) => {
    db.exec(`
      CREATE TABLE groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        group_id TEXT,
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE project_memories (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        source_user TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_pm_group ON project_memories(group_id);
      CREATE TABLE model_configs (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL DEFAULT 'org',
        base_url TEXT,
        model_name TEXT,
        credential TEXT,
        allow_local_override INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `)
    db.exec(`CREATE VIRTUAL TABLE vec_memories USING vec0(memory_id TEXT PRIMARY KEY, embedding float[1024])`)
  }
]

export function getDb(path = process.env.ECHO_SERVER_DB ?? './data/echo-server.db'): DB {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  sqliteVec.load(db)
  const current = db.pragma('user_version', { simple: true }) as number
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      MIGRATIONS[v](db)
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
  return db
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test test/db.test.ts`
Expected: PASS(若 sqlite-vec 在 `:memory:` 报错,改用临时文件路径 `node:os` tmpdir + 随机名)

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: 数据库初始化与建表迁移(含 sqlite-vec 向量虚表)"
```

---

