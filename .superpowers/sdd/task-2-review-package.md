c0a49a7 feat: 数据库初始化与建表迁移(含 sqlite-vec 向量虚表)
---
 src/db.ts       | 59 +++++++++++++++++++++++++++++++++++++++++++++++++++++++++
 test/db.test.ts | 55 +++++++++++++++++++++++++++++++++++++++++++++++++++++
 2 files changed, 114 insertions(+)
---
diff --git a/src/db.ts b/src/db.ts
new file mode 100644
index 0000000..30eb408
--- /dev/null
+++ b/src/db.ts
@@ -0,0 +1,59 @@
+import Database from 'better-sqlite3'
+import * as sqliteVec from 'sqlite-vec'
+
+export type DB = Database.Database
+
+const MIGRATIONS: ((db: DB) => void)[] = [
+  (db) => {
+    db.exec(`
+      CREATE TABLE groups (
+        id TEXT PRIMARY KEY,
+        name TEXT NOT NULL UNIQUE,
+        created_at INTEGER NOT NULL
+      );
+      CREATE TABLE users (
+        id TEXT PRIMARY KEY,
+        username TEXT NOT NULL UNIQUE,
+        password_hash TEXT NOT NULL,
+        role TEXT NOT NULL DEFAULT 'member',
+        group_id TEXT,
+        disabled INTEGER NOT NULL DEFAULT 0,
+        created_at INTEGER NOT NULL
+      );
+      CREATE TABLE project_memories (
+        id TEXT PRIMARY KEY,
+        group_id TEXT NOT NULL,
+        content TEXT NOT NULL,
+        tags TEXT NOT NULL DEFAULT '[]',
+        source_user TEXT NOT NULL,
+        created_at INTEGER NOT NULL,
+        updated_at INTEGER NOT NULL
+      );
+      CREATE INDEX idx_pm_group ON project_memories(group_id);
+      CREATE TABLE model_configs (
+        id TEXT PRIMARY KEY,
+        scope TEXT NOT NULL DEFAULT 'org',
+        base_url TEXT,
+        model_name TEXT,
+        credential TEXT,
+        allow_local_override INTEGER NOT NULL DEFAULT 0,
+        updated_at INTEGER NOT NULL
+      );
+    `)
+    db.exec(`CREATE VIRTUAL TABLE vec_memories USING vec0(memory_id TEXT PRIMARY KEY, embedding float[1024])`)
+  }
+]
+
+export function getDb(path = process.env.ECHO_SERVER_DB ?? './data/echo-server.db'): DB {
+  const db = new Database(path)
+  db.pragma('journal_mode = WAL')
+  sqliteVec.load(db)
+  const current = db.pragma('user_version', { simple: true }) as number
+  for (let v = current; v < MIGRATIONS.length; v++) {
+    db.transaction(() => {
+      MIGRATIONS[v](db)
+      db.pragma(`user_version = ${v + 1}`)
+    })()
+  }
+  return db
+}
diff --git a/test/db.test.ts b/test/db.test.ts
new file mode 100644
index 0000000..ec16180
--- /dev/null
+++ b/test/db.test.ts
@@ -0,0 +1,55 @@
+import { describe, it, expect, afterEach } from 'vitest'
+import { getDb } from '../src/db.js'
+import { rmSync } from 'node:fs'
+import { tmpdir } from 'node:os'
+import { join } from 'node:path'
+
+// Use a temp file instead of :memory: because sqlite-vec may fail on in-memory DBs
+function makeTmpPath() {
+  return join(tmpdir(), `db-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
+}
+
+describe('db migrations', () => {
+  const created: string[] = []
+
+  afterEach(() => {
+    for (const p of created) {
+      try { rmSync(p) } catch { /* ignore */ }
+    }
+    created.length = 0
+  })
+
+  it('creates all tables on a fresh db', () => {
+    const path = makeTmpPath()
+    created.push(path)
+    const db = getDb(path)
+    const names = db
+      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
+      .all()
+      .map((r: any) => r.name)
+    expect(names).toEqual(expect.arrayContaining(['users', 'groups', 'project_memories', 'model_configs']))
+    db.close()
+  })
+
+  it('creates vec_memories virtual table', () => {
+    const path = makeTmpPath()
+    created.push(path)
+    const db = getDb(path)
+    const names = db
+      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
+      .all()
+      .map((r: any) => r.name)
+    expect(names).toContain('vec_memories')
+    db.close()
+  })
+
+  it('is idempotent — calling getDb twice does not re-run migrations', () => {
+    const path = makeTmpPath()
+    created.push(path)
+    const db1 = getDb(path)
+    db1.close()
+    // Should not throw "table already exists"
+    const db2 = getDb(path)
+    db2.close()
+  })
+})
