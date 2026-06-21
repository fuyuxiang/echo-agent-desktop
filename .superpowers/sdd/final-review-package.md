a3a2363 feat: 服务入口、初始管理员引导与启动文档
d849980 fix: model-config 路由用 requireAdmin 替换缺 return 的内联校验
5b766dd feat: 管理路由与模型配置下发(凭证不明文下发)
607572d fix: 统一未分配分组用户的错误响应
8d56d88 feat: 项目记忆 REST 路由(写入/检索/列表/删除,组隔离)
8022006 fix: requireAdmin preHandler 添加 return 中断请求链
855d374 feat: Fastify 应用骨架与 JWT 登录鉴权
265f296 feat: 项目记忆 DAO(向量检索 + group_id 强隔离)
6340fb8 fix: embedding API 错误处理与维度校验
a443c67 feat: 可注入的 embedding 提供者(默认确定性向量桩)
9bb2a66 feat: 用户与组的数据访问层
c0de56e feat: 密码 argon2 哈希与凭证 AES-256-GCM 加密工具
c0a49a7 feat: 数据库初始化与建表迁移(含 sqlite-vec 向量虚表)
---
 README.md                  |  11 +++++
 src/app.ts                 |  37 +++++++++++++++
 src/auth.ts                |  19 ++++++++
 src/crypto.ts              |  35 ++++++++++++++
 src/dao/groups.ts          |  14 ++++++
 src/dao/memories.ts        | 116 +++++++++++++++++++++++++++++++++++++++++++++
 src/dao/users.ts           |  53 +++++++++++++++++++++
 src/db.ts                  |  59 +++++++++++++++++++++++
 src/embedding.ts           |  42 ++++++++++++++++
 src/routes/admin.ts        |  32 +++++++++++++
 src/routes/memory.ts       |  40 ++++++++++++++++
 src/routes/model-config.ts |  32 +++++++++++++
 src/server.ts              |  27 +++++++++++
 src/types.d.ts             |  13 +++++
 test/admin-routes.test.ts  |  38 +++++++++++++++
 test/auth.test.ts          |  25 ++++++++++
 test/bootstrap.test.ts     |  17 +++++++
 test/crypto.test.ts        |  17 +++++++
 test/dao.test.ts           |  44 +++++++++++++++++
 test/db.test.ts            |  55 +++++++++++++++++++++
 test/embedding.test.ts     |  14 ++++++
 test/memories.test.ts      |  43 +++++++++++++++++
 test/memory-routes.test.ts |  42 ++++++++++++++++
 23 files changed, 825 insertions(+)
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
diff --git a/src/app.ts b/src/app.ts
new file mode 100644
index 0000000..5b305b6
--- /dev/null
+++ b/src/app.ts
@@ -0,0 +1,37 @@
+import Fastify, { type FastifyInstance } from 'fastify'
+import jwt from '@fastify/jwt'
+import type { DB } from './db.js'
+import type { EmbeddingProvider } from './embedding.js'
+import { ok, fail } from './reply.js'
+import { findUserRowByName } from './dao/users.js'
+import { verifyPassword } from './crypto.js'
+import { authenticate, type JwtClaims } from './auth.js'
+import { registerMemoryRoutes } from './routes/memory.js'
+import { registerAdminRoutes } from './routes/admin.js'
+import { registerModelConfigRoutes } from './routes/model-config.js'
+
+export interface Deps { db: DB; embed: EmbeddingProvider }
+
+export function buildApp(deps: Deps): FastifyInstance {
+  const app = Fastify({ logger: false })
+  app.decorate('deps', deps)
+  app.register(jwt, { secret: process.env.ECHO_SERVER_SECRET ?? 'dev-secret' })
+  app.decorate('authenticate', authenticate)
+
+  app.post('/api/auth/login', async (req, reply) => {
+    const { username, password } = (req.body ?? {}) as { username?: string; password?: string }
+    if (!username || !password) return reply.send(fail(1001, '缺少用户名或密码'))
+    const row = findUserRowByName(deps.db, username)
+    if (!row || row.disabled) return reply.send(fail(1002, '用户不存在或已禁用'))
+    if (!(await verifyPassword(row.password_hash, password))) return reply.send(fail(1003, '密码错误'))
+    const claims: JwtClaims = { sub: row.id, role: row.role, groupId: row.group_id }
+    const token = app.jwt.sign(claims, { expiresIn: '7d' })
+    return reply.send(ok({ token, user: { id: row.id, username: row.username, role: row.role, groupId: row.group_id } }))
+  })
+
+  registerMemoryRoutes(app)
+  registerAdminRoutes(app)
+  registerModelConfigRoutes(app)
+
+  return app
+}
diff --git a/src/auth.ts b/src/auth.ts
new file mode 100644
index 0000000..65dfb48
--- /dev/null
+++ b/src/auth.ts
@@ -0,0 +1,19 @@
+import type { FastifyReply, FastifyRequest } from 'fastify'
+import { fail } from './reply.js'
+
+export interface JwtClaims { sub: string; role: 'member' | 'admin'; groupId: string | null }
+
+export async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
+  try {
+    await req.jwtVerify()
+  } catch {
+    reply.code(401).send(fail(4011, '未认证或登录已过期'))
+  }
+}
+
+export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
+  const claims = req.user as JwtClaims
+  if (claims?.role !== 'admin') {
+    return reply.code(403).send(fail(4031, '需要管理员权限'))
+  }
+}
diff --git a/src/crypto.ts b/src/crypto.ts
new file mode 100644
index 0000000..6ed12a7
--- /dev/null
+++ b/src/crypto.ts
@@ -0,0 +1,35 @@
+import argon2 from 'argon2'
+import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'
+
+export function hashPassword(plain: string): Promise<string> {
+  return argon2.hash(plain)
+}
+
+export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
+  try {
+    return await argon2.verify(hash, plain)
+  } catch {
+    return false
+  }
+}
+
+function key(): Buffer {
+  const secret = process.env.ECHO_SERVER_SECRET
+  if (!secret) throw new Error('ECHO_SERVER_SECRET not set')
+  return createHash('sha256').update(secret).digest()
+}
+
+export function encryptSecret(plain: string): string {
+  const iv = randomBytes(12)
+  const cipher = createCipheriv('aes-256-gcm', key(), iv)
+  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
+  const tag = cipher.getAuthTag()
+  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.')
+}
+
+export function decryptSecret(blob: string): string {
+  const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'))
+  const decipher = createDecipheriv('aes-256-gcm', key(), iv)
+  decipher.setAuthTag(tag)
+  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
+}
diff --git a/src/dao/groups.ts b/src/dao/groups.ts
new file mode 100644
index 0000000..0a665be
--- /dev/null
+++ b/src/dao/groups.ts
@@ -0,0 +1,14 @@
+import { randomUUID } from 'node:crypto'
+import type { DB } from '../db.js'
+
+export interface Group { id: string; name: string; createdAt: number }
+
+export function createGroup(db: DB, name: string): Group {
+  const g: Group = { id: randomUUID(), name, createdAt: Date.now() }
+  db.prepare('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(g.id, g.name, g.createdAt)
+  return g
+}
+
+export function listGroups(db: DB): Group[] {
+  return db.prepare('SELECT id, name, created_at as createdAt FROM groups ORDER BY created_at').all() as Group[]
+}
diff --git a/src/dao/memories.ts b/src/dao/memories.ts
new file mode 100644
index 0000000..976771c
--- /dev/null
+++ b/src/dao/memories.ts
@@ -0,0 +1,116 @@
+import { randomUUID } from 'node:crypto'
+import type { DB } from '../db.js'
+import type { EmbeddingProvider } from '../embedding.js'
+
+export interface Memory {
+  id: string
+  groupId: string
+  content: string
+  tags: string[]
+  sourceUser: string
+  createdAt: number
+  updatedAt: number
+}
+
+interface Row {
+  id: string
+  group_id: string
+  content: string
+  tags: string
+  source_user: string
+  created_at: number
+  updated_at: number
+}
+
+function toMem(r: Row): Memory {
+  return {
+    id: r.id,
+    groupId: r.group_id,
+    content: r.content,
+    tags: JSON.parse(r.tags),
+    sourceUser: r.source_user,
+    createdAt: r.created_at,
+    updatedAt: r.updated_at,
+  }
+}
+
+export async function addMemory(
+  db: DB,
+  embed: EmbeddingProvider,
+  input: { groupId: string; content: string; tags: string[]; sourceUser: string }
+): Promise<Memory> {
+  const id = randomUUID()
+  const now = Date.now()
+  db.prepare(
+    'INSERT INTO project_memories (id, group_id, content, tags, source_user, created_at, updated_at) VALUES (?,?,?,?,?,?,?)'
+  ).run(id, input.groupId, input.content, JSON.stringify(input.tags), input.sourceUser, now, now)
+  const vec = await embed.embed(input.content)
+  db.prepare('INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)').run(
+    id,
+    new Float32Array(vec)
+  )
+  return {
+    id,
+    groupId: input.groupId,
+    content: input.content,
+    tags: input.tags,
+    sourceUser: input.sourceUser,
+    createdAt: now,
+    updatedAt: now,
+  }
+}
+
+export async function searchMemories(
+  db: DB,
+  embed: EmbeddingProvider,
+  input: { groupId: string; query: string; topK: number }
+): Promise<Memory[]> {
+  const vec = await embed.embed(input.query)
+  // Step 1: KNN query to get candidate memory_ids with distances
+  // sqlite-vec requires the MATCH + k = ? to be the only WHERE clause on the virtual table
+  const candidates = db
+    .prepare(
+      `SELECT memory_id, distance FROM vec_memories WHERE embedding MATCH ? AND k = ?`
+    )
+    .all(new Float32Array(vec), input.topK) as { memory_id: string; distance: number }[]
+
+  if (candidates.length === 0) return []
+
+  // Step 2: fetch project_memories for these candidates, enforcing group_id isolation
+  const ids = candidates.map((c) => c.memory_id)
+  const placeholders = ids.map(() => '?').join(',')
+  const rows = db
+    .prepare(
+      `SELECT * FROM project_memories WHERE id IN (${placeholders}) AND group_id = ? ORDER BY created_at DESC`
+    )
+    .all(...ids, input.groupId) as Row[]
+
+  // Preserve distance ordering from KNN result
+  const distMap = new Map(candidates.map((c) => [c.memory_id, c.distance]))
+  rows.sort((a, b) => (distMap.get(a.id) ?? 0) - (distMap.get(b.id) ?? 0))
+
+  return rows.map(toMem)
+}
+
+export function listMemories(
+  db: DB,
+  input: { groupId: string; limit: number; offset: number }
+): Memory[] {
+  const rows = db
+    .prepare(
+      'SELECT * FROM project_memories WHERE group_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
+    )
+    .all(input.groupId, input.limit, input.offset) as Row[]
+  return rows.map(toMem)
+}
+
+export function deleteMemory(db: DB, input: { groupId: string; id: string }): boolean {
+  const res = db
+    .prepare('DELETE FROM project_memories WHERE id = ? AND group_id = ?')
+    .run(input.id, input.groupId)
+  if (res.changes > 0) {
+    db.prepare('DELETE FROM vec_memories WHERE memory_id = ?').run(input.id)
+    return true
+  }
+  return false
+}
diff --git a/src/dao/users.ts b/src/dao/users.ts
new file mode 100644
index 0000000..6110309
--- /dev/null
+++ b/src/dao/users.ts
@@ -0,0 +1,53 @@
+import { randomUUID } from 'node:crypto'
+import type { DB } from '../db.js'
+import { hashPassword } from '../crypto.js'
+
+export interface User {
+  id: string
+  username: string
+  role: 'member' | 'admin'
+  groupId: string | null
+  disabled: boolean
+}
+
+interface UserRow {
+  id: string; username: string; password_hash: string
+  role: 'member' | 'admin'; group_id: string | null; disabled: number
+}
+
+function toUser(r: UserRow): User {
+  return { id: r.id, username: r.username, role: r.role, groupId: r.group_id, disabled: !!r.disabled }
+}
+
+export async function createUser(
+  db: DB,
+  input: { username: string; password: string; role: 'member' | 'admin'; groupId: string | null }
+): Promise<User> {
+  const id = randomUUID()
+  const hash = await hashPassword(input.password)
+  db.prepare(
+    'INSERT INTO users (id, username, password_hash, role, group_id, disabled, created_at) VALUES (?,?,?,?,?,0,?)'
+  ).run(id, input.username, hash, input.role, input.groupId, Date.now())
+  return { id, username: input.username, role: input.role, groupId: input.groupId, disabled: false }
+}
+
+export function findUserRowByName(db: DB, username: string): UserRow | undefined {
+  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined
+}
+
+export function findUserByName(db: DB, username: string): User | undefined {
+  const r = findUserRowByName(db, username)
+  return r ? toUser(r) : undefined
+}
+
+export function listUsers(db: DB): User[] {
+  return (db.prepare('SELECT * FROM users ORDER BY created_at').all() as UserRow[]).map(toUser)
+}
+
+export function setUserGroup(db: DB, userId: string, groupId: string): void {
+  db.prepare('UPDATE users SET group_id = ? WHERE id = ?').run(groupId, userId)
+}
+
+export function setUserDisabled(db: DB, userId: string, disabled: boolean): void {
+  db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, userId)
+}
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
diff --git a/src/embedding.ts b/src/embedding.ts
new file mode 100644
index 0000000..1c5aaee
--- /dev/null
+++ b/src/embedding.ts
@@ -0,0 +1,42 @@
+import { createHash } from 'node:crypto'
+
+export interface EmbeddingProvider {
+  embed(text: string): Promise<number[]>
+}
+
+export function hashEmbedding(text: string, dim = 1024): number[] {
+  const vec = new Array<number>(dim).fill(0)
+  // spread tokens across dimensions via rolling hash for a deterministic pseudo-vector
+  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean)
+  for (const tok of tokens) {
+    const h = createHash('md5').update(tok).digest()
+    for (let i = 0; i < h.length; i++) {
+      vec[(h[i] + i * 31) % dim] += (h[i] - 128) / 128
+    }
+  }
+  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1
+  return vec.map((x) => x / norm)
+}
+
+export function createEmbeddingProvider(): EmbeddingProvider {
+  const url = process.env.ECHO_EMBED_URL
+  const k = process.env.ECHO_EMBED_KEY
+  const model = process.env.ECHO_EMBED_MODEL ?? 'text-embedding-3-small'
+  if (!url || !k) {
+    return { embed: async (t) => hashEmbedding(t) }
+  }
+  return {
+    async embed(text: string): Promise<number[]> {
+      const res = await fetch(url, {
+        method: 'POST',
+        headers: { 'content-type': 'application/json', authorization: `Bearer ${k}` },
+        body: JSON.stringify({ model, input: text })
+      })
+      if (!res.ok) throw new Error(`embedding API error ${res.status}: ${await res.text()}`)
+      const json = (await res.json()) as { data: { embedding: number[] }[] }
+      const vec = json.data[0].embedding
+      if (vec.length !== 1024) throw new Error(`embedding dim mismatch: expected 1024, got ${vec.length}. Set ECHO_EMBED_MODEL to a 1024-dim model or configure dimensions parameter`)
+      return vec
+    }
+  }
+}
diff --git a/src/routes/admin.ts b/src/routes/admin.ts
new file mode 100644
index 0000000..09d24d6
--- /dev/null
+++ b/src/routes/admin.ts
@@ -0,0 +1,32 @@
+import type { FastifyInstance } from 'fastify'
+import { ok, fail } from '../reply.js'
+import { requireAdmin } from '../auth.js'
+import { createGroup, listGroups } from '../dao/groups.js'
+import { createUser, listUsers, setUserGroup, setUserDisabled, findUserByName } from '../dao/users.js'
+
+export function registerAdminRoutes(app: FastifyInstance): void {
+  const { db } = app.deps
+  const guard = { preHandler: [app.authenticate, requireAdmin] }
+
+  app.get('/api/admin/groups', guard, async (_req, reply) => reply.send(ok(listGroups(db))))
+  app.post('/api/admin/groups', guard, async (req, reply) => {
+    const { name } = (req.body ?? {}) as { name?: string }
+    if (!name) return reply.send(fail(1020, '组名不能为空'))
+    return reply.send(ok(createGroup(db, name)))
+  })
+
+  app.get('/api/admin/users', guard, async (_req, reply) => reply.send(ok(listUsers(db))))
+  app.post('/api/admin/users', guard, async (req, reply) => {
+    const { username, password, role, groupId } = (req.body ?? {}) as any
+    if (!username || !password) return reply.send(fail(1021, '缺少用户名或密码'))
+    if (findUserByName(db, username)) return reply.send(fail(1022, '用户名已存在'))
+    return reply.send(ok(await createUser(db, { username, password, role: role ?? 'member', groupId: groupId ?? null })))
+  })
+  app.patch('/api/admin/users/:id', guard, async (req, reply) => {
+    const { id } = req.params as { id: string }
+    const { groupId, disabled } = (req.body ?? {}) as { groupId?: string; disabled?: boolean }
+    if (groupId !== undefined) setUserGroup(db, id, groupId)
+    if (disabled !== undefined) setUserDisabled(db, id, disabled)
+    return reply.send(ok({ updated: true }))
+  })
+}
diff --git a/src/routes/memory.ts b/src/routes/memory.ts
new file mode 100644
index 0000000..b125b56
--- /dev/null
+++ b/src/routes/memory.ts
@@ -0,0 +1,40 @@
+import type { FastifyInstance } from 'fastify'
+import { ok, fail } from '../reply.js'
+import type { JwtClaims } from '../auth.js'
+import { addMemory, searchMemories, listMemories, deleteMemory } from '../dao/memories.js'
+
+export function registerMemoryRoutes(app: FastifyInstance): void {
+  const { db, embed } = app.deps
+
+  app.post('/api/project-memory', { preHandler: app.authenticate }, async (req, reply) => {
+    const c = req.user as JwtClaims
+    if (!c.groupId) return reply.send(fail(1010, '当前用户未分配分组'))
+    const { content, tags } = (req.body ?? {}) as { content?: string; tags?: string[] }
+    if (!content) return reply.send(fail(1011, '记忆内容不能为空'))
+    const mem = await addMemory(db, embed, { groupId: c.groupId, content, tags: tags ?? [], sourceUser: c.sub })
+    return reply.send(ok(mem))
+  })
+
+  app.post('/api/project-memory/search', { preHandler: app.authenticate }, async (req, reply) => {
+    const c = req.user as JwtClaims
+    if (!c.groupId) return reply.send(fail(1010, '当前用户未分配分组'))
+    const { query, topK } = (req.body ?? {}) as { query?: string; topK?: number }
+    if (!query) return reply.send(fail(1012, '检索 query 不能为空'))
+    const res = await searchMemories(db, embed, { groupId: c.groupId, query, topK: topK ?? 5 })
+    return reply.send(ok(res))
+  })
+
+  app.get('/api/project-memory', { preHandler: app.authenticate }, async (req, reply) => {
+    const c = req.user as JwtClaims
+    if (!c.groupId) return reply.send(fail(1010, '当前用户未分配分组'))
+    const { limit, offset } = (req.query ?? {}) as { limit?: string; offset?: string }
+    return reply.send(ok(listMemories(db, { groupId: c.groupId, limit: Number(limit ?? 50), offset: Number(offset ?? 0) })))
+  })
+
+  app.delete('/api/project-memory/:id', { preHandler: app.authenticate }, async (req, reply) => {
+    const c = req.user as JwtClaims
+    if (!c.groupId) return reply.send(fail(1010, '当前用户未分配分组'))
+    const { id } = req.params as { id: string }
+    return reply.send(ok({ deleted: deleteMemory(db, { groupId: c.groupId, id }) }))
+  })
+}
diff --git a/src/routes/model-config.ts b/src/routes/model-config.ts
new file mode 100644
index 0000000..a29efc4
--- /dev/null
+++ b/src/routes/model-config.ts
@@ -0,0 +1,32 @@
+import type { FastifyInstance } from 'fastify'
+import { ok } from '../reply.js'
+import { encryptSecret } from '../crypto.js'
+import { requireAdmin } from '../auth.js'
+
+const ROW_ID = 'org-default'
+
+export function registerModelConfigRoutes(app: FastifyInstance): void {
+  const { db } = app.deps
+
+  app.get('/api/model-config', { preHandler: app.authenticate }, async (_req, reply) => {
+    const row = db.prepare('SELECT * FROM model_configs WHERE id = ?').get(ROW_ID) as any
+    if (!row) return reply.send(ok({ baseUrl: null, modelName: null, allowLocalOverride: true, hasCredential: false }))
+    return reply.send(ok({
+      baseUrl: row.base_url, modelName: row.model_name,
+      allowLocalOverride: !!row.allow_local_override, hasCredential: !!row.credential
+    }))
+  })
+
+  app.put('/api/admin/model-config', { preHandler: [app.authenticate, requireAdmin] }, async (req, reply) => {
+    const { baseUrl, modelName, credential, allowLocalOverride } = (req.body ?? {}) as any
+    const enc = credential ? encryptSecret(credential) : null
+    db.prepare(`
+      INSERT INTO model_configs (id, scope, base_url, model_name, credential, allow_local_override, updated_at)
+      VALUES (?, 'org', ?, ?, ?, ?, ?)
+      ON CONFLICT(id) DO UPDATE SET base_url=excluded.base_url, model_name=excluded.model_name,
+        credential=COALESCE(excluded.credential, model_configs.credential),
+        allow_local_override=excluded.allow_local_override, updated_at=excluded.updated_at
+    `).run(ROW_ID, baseUrl ?? null, modelName ?? null, enc, allowLocalOverride ? 1 : 0, Date.now())
+    return reply.send(ok({ updated: true }))
+  })
+}
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
diff --git a/src/types.d.ts b/src/types.d.ts
new file mode 100644
index 0000000..2586ba7
--- /dev/null
+++ b/src/types.d.ts
@@ -0,0 +1,13 @@
+import type { Deps } from './app.js'
+declare module 'fastify' {
+  interface FastifyInstance {
+    deps: Deps
+    authenticate: (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>
+  }
+}
+declare module '@fastify/jwt' {
+  interface FastifyJWT {
+    payload: { sub: string; role: 'member' | 'admin'; groupId: string | null }
+    user: { sub: string; role: 'member' | 'admin'; groupId: string | null }
+  }
+}
diff --git a/test/admin-routes.test.ts b/test/admin-routes.test.ts
new file mode 100644
index 0000000..1c0867d
--- /dev/null
+++ b/test/admin-routes.test.ts
@@ -0,0 +1,38 @@
+import { describe, it, expect, beforeEach } from 'vitest'
+import { getDb, type DB } from '../src/db.js'
+import { hashEmbedding } from '../src/embedding.js'
+import { createUser } from '../src/dao/users.js'
+import { buildApp } from '../src/app.js'
+
+process.env.ECHO_SERVER_SECRET = 'test-secret-key-32-bytes-long!!'
+let db: DB
+const embed = { embed: async (t: string) => hashEmbedding(t) }
+beforeEach(() => { db = getDb(':memory:') })
+
+async function login(app: any, u: string, p: string) {
+  return (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } })).json().data.token
+}
+
+describe('admin & model-config routes', () => {
+  it('admin creates group+user, member cannot', async () => {
+    await createUser(db, { username: 'root', password: 'pw', role: 'admin', groupId: null })
+    const app = buildApp({ db, embed })
+    const t = await login(app, 'root', 'pw')
+    const g = await app.inject({ method: 'POST', url: '/api/admin/groups', headers: { authorization: `Bearer ${t}` }, payload: { name: '研发' } })
+    expect(g.json().code).toBe(0)
+    await app.inject({ method: 'POST', url: '/api/admin/users', headers: { authorization: `Bearer ${t}` }, payload: { username: 'm', password: 'pw', role: 'member', groupId: g.json().data.id } })
+    const tm = await login(app, 'm', 'pw')
+    const denied = await app.inject({ method: 'POST', url: '/api/admin/groups', headers: { authorization: `Bearer ${tm}` }, payload: { name: 'x' } })
+    expect(denied.statusCode).toBe(403)
+  })
+
+  it('model-config hides credential plaintext', async () => {
+    await createUser(db, { username: 'root', password: 'pw', role: 'admin', groupId: null })
+    const app = buildApp({ db, embed })
+    const t = await login(app, 'root', 'pw')
+    await app.inject({ method: 'PUT', url: '/api/admin/model-config', headers: { authorization: `Bearer ${t}` }, payload: { baseUrl: 'https://api.x', modelName: 'gpt', credential: 'sk-secret', allowLocalOverride: false } })
+    const got = await app.inject({ method: 'GET', url: '/api/model-config', headers: { authorization: `Bearer ${t}` } })
+    expect(JSON.stringify(got.json())).not.toContain('sk-secret')
+    expect(got.json().data.hasCredential).toBe(true)
+  })
+})
diff --git a/test/auth.test.ts b/test/auth.test.ts
new file mode 100644
index 0000000..7648357
--- /dev/null
+++ b/test/auth.test.ts
@@ -0,0 +1,25 @@
+import { describe, it, expect, beforeEach } from 'vitest'
+import { getDb, type DB } from '../src/db.js'
+import { hashEmbedding } from '../src/embedding.js'
+import { createGroup } from '../src/dao/groups.js'
+import { createUser } from '../src/dao/users.js'
+import { buildApp } from '../src/app.js'
+
+process.env.ECHO_SERVER_SECRET = 'test-secret-key-32-bytes-long!!'
+let db: DB
+beforeEach(() => { db = getDb(':memory:') })
+
+describe('auth', () => {
+  it('logs in with correct credentials and rejects wrong', async () => {
+    const g = createGroup(db, 'g1')
+    await createUser(db, { username: 'alice', password: 'pw', role: 'member', groupId: g.id })
+    const app = buildApp({ db, embed: { embed: async (t) => hashEmbedding(t) } })
+
+    const okRes = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'pw' } })
+    expect(okRes.json().code).toBe(0)
+    expect(okRes.json().data.token).toBeTypeOf('string')
+
+    const badRes = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'no' } })
+    expect(badRes.json().code).not.toBe(0)
+  }, 15000)
+})
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
diff --git a/test/crypto.test.ts b/test/crypto.test.ts
new file mode 100644
index 0000000..208d551
--- /dev/null
+++ b/test/crypto.test.ts
@@ -0,0 +1,17 @@
+import { describe, it, expect, beforeAll } from 'vitest'
+import { hashPassword, verifyPassword, encryptSecret, decryptSecret } from '../src/crypto.js'
+
+beforeAll(() => { process.env.ECHO_SERVER_SECRET = 'test-secret-key-32-bytes-long!!' })
+
+describe('crypto', () => {
+  it('verifies a correct password and rejects wrong', async () => {
+    const h = await hashPassword('s3cret')
+    expect(await verifyPassword(h, 's3cret')).toBe(true)
+    expect(await verifyPassword(h, 'wrong')).toBe(false)
+  })
+  it('round-trips an encrypted secret', () => {
+    const blob = encryptSecret('sk-12345')
+    expect(blob).not.toContain('sk-12345')
+    expect(decryptSecret(blob)).toBe('sk-12345')
+  })
+})
diff --git a/test/dao.test.ts b/test/dao.test.ts
new file mode 100644
index 0000000..c5e8986
--- /dev/null
+++ b/test/dao.test.ts
@@ -0,0 +1,44 @@
+import { describe, it, expect, beforeEach, afterEach } from 'vitest'
+import { rmSync } from 'node:fs'
+import { tmpdir } from 'node:os'
+import { join } from 'node:path'
+import { getDb, type DB } from '../src/db.js'
+import { createUser, findUserByName, listUsers, setUserGroup } from '../src/dao/users.js'
+import { createGroup, listGroups } from '../src/dao/groups.js'
+
+function makeTmpPath() {
+  return join(tmpdir(), `dao-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
+}
+
+let db: DB
+let tmpPath: string
+
+beforeEach(() => {
+  tmpPath = makeTmpPath()
+  db = getDb(tmpPath)
+})
+
+afterEach(() => {
+  try { db.close() } catch { /* ignore */ }
+  try { rmSync(tmpPath) } catch { /* ignore */ }
+})
+
+describe('users & groups dao', () => {
+  it('creates a group and a user assigned to it', async () => {
+    const g = createGroup(db, '研发组')
+    expect(listGroups(db)).toHaveLength(1)
+    const u = await createUser(db, { username: 'alice', password: 'pw', role: 'member', groupId: g.id })
+    expect(u.username).toBe('alice')
+    expect((u as any).password_hash).toBeUndefined()
+    expect(findUserByName(db, 'alice')?.groupId).toBe(g.id)
+  })
+
+  it('moves a user to another group', async () => {
+    const g1 = createGroup(db, 'a')
+    const g2 = createGroup(db, 'b')
+    const u = await createUser(db, { username: 'bob', password: 'pw', role: 'member', groupId: g1.id })
+    setUserGroup(db, u.id, g2.id)
+    expect(findUserByName(db, 'bob')?.groupId).toBe(g2.id)
+    expect(listUsers(db)).toHaveLength(1)
+  })
+})
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
diff --git a/test/embedding.test.ts b/test/embedding.test.ts
new file mode 100644
index 0000000..a9195c6
--- /dev/null
+++ b/test/embedding.test.ts
@@ -0,0 +1,14 @@
+import { describe, it, expect } from 'vitest'
+import { hashEmbedding } from '../src/embedding.js'
+
+describe('hashEmbedding', () => {
+  it('is deterministic and correct length', () => {
+    const a = hashEmbedding('hello', 1024)
+    const b = hashEmbedding('hello', 1024)
+    expect(a).toHaveLength(1024)
+    expect(a).toEqual(b)
+  })
+  it('differs for different text', () => {
+    expect(hashEmbedding('a')).not.toEqual(hashEmbedding('b'))
+  })
+})
diff --git a/test/memories.test.ts b/test/memories.test.ts
new file mode 100644
index 0000000..7c9b8ce
--- /dev/null
+++ b/test/memories.test.ts
@@ -0,0 +1,43 @@
+import { describe, it, expect, beforeEach, afterEach } from 'vitest'
+import { rmSync } from 'node:fs'
+import { tmpdir } from 'node:os'
+import { join } from 'node:path'
+import { getDb, type DB } from '../src/db.js'
+import { hashEmbedding } from '../src/embedding.js'
+import { addMemory, searchMemories, listMemories, deleteMemory } from '../src/dao/memories.js'
+
+// sqlite-vec does not support :memory: — use a temp file per test
+function makeTmpPath() {
+  return join(tmpdir(), `mem-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
+}
+
+const embed = { embed: async (t: string) => hashEmbedding(t) }
+let db: DB
+let dbPath: string
+
+beforeEach(() => {
+  dbPath = makeTmpPath()
+  db = getDb(dbPath)
+})
+
+afterEach(() => {
+  db.close()
+  try { rmSync(dbPath) } catch { /* ignore */ }
+})
+
+describe('project memory dao', () => {
+  it('search only returns memories of the same group', async () => {
+    await addMemory(db, embed, { groupId: 'g1', content: '部署流程用 k8s', tags: [], sourceUser: 'u1' })
+    await addMemory(db, embed, { groupId: 'g2', content: '部署流程用 k8s', tags: [], sourceUser: 'u2' })
+    const res = await searchMemories(db, embed, { groupId: 'g1', query: '部署流程', topK: 5 })
+    expect(res.length).toBeGreaterThanOrEqual(1)
+    expect(res.every((m) => m.groupId === 'g1')).toBe(true)
+  })
+
+  it('lists and deletes within group scope', async () => {
+    const m = await addMemory(db, embed, { groupId: 'g1', content: 'x', tags: ['a'], sourceUser: 'u1' })
+    expect(listMemories(db, { groupId: 'g1', limit: 10, offset: 0 })).toHaveLength(1)
+    expect(deleteMemory(db, { groupId: 'g2', id: m.id })).toBe(false) // 跨组删不掉
+    expect(deleteMemory(db, { groupId: 'g1', id: m.id })).toBe(true)
+  })
+})
diff --git a/test/memory-routes.test.ts b/test/memory-routes.test.ts
new file mode 100644
index 0000000..2e9fff0
--- /dev/null
+++ b/test/memory-routes.test.ts
@@ -0,0 +1,42 @@
+import { describe, it, expect, beforeEach } from 'vitest'
+import { getDb, type DB } from '../src/db.js'
+import { hashEmbedding } from '../src/embedding.js'
+import { createGroup } from '../src/dao/groups.js'
+import { createUser } from '../src/dao/users.js'
+import { buildApp } from '../src/app.js'
+
+process.env.ECHO_SERVER_SECRET = 'test-secret-key-32-bytes-long!!'
+let db: DB
+const embed = { embed: async (t: string) => hashEmbedding(t) }
+
+async function tokenFor(app: any, username: string, password: string): Promise<string> {
+  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } })
+  return r.json().data.token
+}
+
+beforeEach(() => { db = getDb(':memory:') })
+
+describe('project-memory routes', () => {
+  it('writes and searches within own group only', async () => {
+    const g1 = createGroup(db, 'g1'); const g2 = createGroup(db, 'g2')
+    await createUser(db, { username: 'a', password: 'pw', role: 'member', groupId: g1.id })
+    await createUser(db, { username: 'b', password: 'pw', role: 'member', groupId: g2.id })
+    const app = buildApp({ db, embed })
+    const ta = await tokenFor(app, 'a', 'pw')
+    const tb = await tokenFor(app, 'b', 'pw')
+
+    await app.inject({ method: 'POST', url: '/api/project-memory', headers: { authorization: `Bearer ${ta}` }, payload: { content: 'g1 的部署规范' } })
+
+    const sa = await app.inject({ method: 'POST', url: '/api/project-memory/search', headers: { authorization: `Bearer ${ta}` }, payload: { query: '部署规范' } })
+    expect(sa.json().data.length).toBeGreaterThanOrEqual(1)
+
+    const sb = await app.inject({ method: 'POST', url: '/api/project-memory/search', headers: { authorization: `Bearer ${tb}` }, payload: { query: '部署规范' } })
+    expect(sb.json().data).toHaveLength(0) // b 组看不到 a 组记忆
+  })
+
+  it('rejects unauthenticated write', async () => {
+    const app = buildApp({ db, embed })
+    const res = await app.inject({ method: 'POST', url: '/api/project-memory', payload: { content: 'x' } })
+    expect(res.statusCode).toBe(401)
+  })
+})
