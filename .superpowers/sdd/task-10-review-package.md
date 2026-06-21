a3a2363 feat: 服务入口、初始管理员引导与启动文档
---
 README.md              | 11 +++++++++++
 src/server.ts          | 27 +++++++++++++++++++++++++++
 test/bootstrap.test.ts | 17 +++++++++++++++++
 3 files changed, 55 insertions(+)
---
diff --git a/README.md b/README.md
new file mode 100644
index 0000000..391f7f3
--- /dev/null
+++ b/README.md
@@ -0,0 +1,11 @@
+# echo-agent-server
+
+Echo Agent 企业版的项目记忆服务：账号/分组/JWT、项目记忆向量检索（组隔离）、模型配置下发。
+
+## 启动
+1. 复制 `.env.example` 为 `.env`，设置 `ECHO_SERVER_SECRET`（>=32 字节）与初始管理员。
+2. `npm install && npm run dev`（开发）或 `npm run build && npm start`（生产）。
+3. 首启自动用 `ECHO_ADMIN_USER/PASSWORD` 创建超级管理员。
+
+## 向量检索
+默认使用确定性 hash 向量（零依赖，可离线）。配置 `ECHO_EMBED_URL/KEY/MODEL`（OpenAI 兼容 `/embeddings`）后切换为真实 embedding。
diff --git a/src/server.ts b/src/server.ts
new file mode 100644
index 0000000..a5b6b2b
--- /dev/null
+++ b/src/server.ts
@@ -0,0 +1,27 @@
+import type { DB } from './db.js'
+import { getDb } from './db.js'
+import { listUsers, createUser } from './dao/users.js'
+import { createEmbeddingProvider } from './embedding.js'
+import { buildApp } from './app.js'
+
+export async function ensureInitialAdmin(db: DB): Promise<void> {
+  if (listUsers(db).length > 0) return
+  const username = process.env.ECHO_ADMIN_USER ?? 'admin'
+  const password = process.env.ECHO_ADMIN_PASSWORD ?? 'admin12345'
+  await createUser(db, { username, password, role: 'admin', groupId: null })
+}
+
+export async function start(): Promise<void> {
+  const db = getDb()
+  await ensureInitialAdmin(db)
+  const app = buildApp({ db, embed: createEmbeddingProvider() })
+  const port = Number(process.env.ECHO_SERVER_PORT ?? 8787)
+  await app.listen({ port, host: '0.0.0.0' })
+  // eslint-disable-next-line no-console
+  console.log(`echo-agent-server listening on :${port}`)
+}
+
+// 直接运行入口
+if (process.argv[1] && process.argv[1].endsWith('server.js')) {
+  start().catch((e) => { console.error(e); process.exit(1) })
+}
diff --git a/test/bootstrap.test.ts b/test/bootstrap.test.ts
new file mode 100644
index 0000000..9cba0bc
--- /dev/null
+++ b/test/bootstrap.test.ts
@@ -0,0 +1,17 @@
+import { describe, it, expect, beforeEach } from 'vitest'
+import { getDb, type DB } from '../src/db.js'
+import { ensureInitialAdmin } from '../src/server.js'
+import { listUsers } from '../src/dao/users.js'
+
+let db: DB
+beforeEach(() => { db = getDb(':memory:'); process.env.ECHO_ADMIN_USER = 'root'; process.env.ECHO_ADMIN_PASSWORD = 'rootpw' })
+
+describe('initial admin', () => {
+  it('creates an admin when db is empty, idempotent', async () => {
+    await ensureInitialAdmin(db)
+    await ensureInitialAdmin(db)
+    const admins = listUsers(db).filter((u) => u.role === 'admin')
+    expect(admins).toHaveLength(1)
+    expect(admins[0].username).toBe('root')
+  })
+})
