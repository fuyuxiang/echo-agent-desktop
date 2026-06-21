607572d fix: 统一未分配分组用户的错误响应
8d56d88 feat: 项目记忆 REST 路由(写入/检索/列表/删除,组隔离)
---
 src/app.ts                 |  3 +++
 src/routes/memory.ts       | 40 ++++++++++++++++++++++++++++++++++++++++
 test/memory-routes.test.ts | 42 ++++++++++++++++++++++++++++++++++++++++++
 3 files changed, 85 insertions(+)
---
diff --git a/src/app.ts b/src/app.ts
index 78376ab..c8b8f97 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,30 +1,33 @@
 import Fastify, { type FastifyInstance } from 'fastify'
 import jwt from '@fastify/jwt'
 import type { DB } from './db.js'
 import type { EmbeddingProvider } from './embedding.js'
 import { ok, fail } from './reply.js'
 import { findUserRowByName } from './dao/users.js'
 import { verifyPassword } from './crypto.js'
 import { authenticate, type JwtClaims } from './auth.js'
+import { registerMemoryRoutes } from './routes/memory.js'
 
 export interface Deps { db: DB; embed: EmbeddingProvider }
 
 export function buildApp(deps: Deps): FastifyInstance {
   const app = Fastify({ logger: false })
   app.decorate('deps', deps)
   app.register(jwt, { secret: process.env.ECHO_SERVER_SECRET ?? 'dev-secret' })
   app.decorate('authenticate', authenticate)
 
   app.post('/api/auth/login', async (req, reply) => {
     const { username, password } = (req.body ?? {}) as { username?: string; password?: string }
     if (!username || !password) return reply.send(fail(1001, '缺少用户名或密码'))
     const row = findUserRowByName(deps.db, username)
     if (!row || row.disabled) return reply.send(fail(1002, '用户不存在或已禁用'))
     if (!(await verifyPassword(row.password_hash, password))) return reply.send(fail(1003, '密码错误'))
     const claims: JwtClaims = { sub: row.id, role: row.role, groupId: row.group_id }
     const token = app.jwt.sign(claims, { expiresIn: '7d' })
     return reply.send(ok({ token, user: { id: row.id, username: row.username, role: row.role, groupId: row.group_id } }))
   })
 
+  registerMemoryRoutes(app)
+
   return app
 }
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
