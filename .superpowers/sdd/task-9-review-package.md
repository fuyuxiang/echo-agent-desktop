5b766dd feat: 管理路由与模型配置下发(凭证不明文下发)
---
 src/app.ts                 |  4 ++++
 src/routes/admin.ts        | 32 ++++++++++++++++++++++++++++++++
 src/routes/model-config.ts | 36 ++++++++++++++++++++++++++++++++++++
 test/admin-routes.test.ts  | 38 ++++++++++++++++++++++++++++++++++++++
 4 files changed, 110 insertions(+)
---
diff --git a/src/app.ts b/src/app.ts
index c8b8f97..5b305b6 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,19 +1,21 @@
 import Fastify, { type FastifyInstance } from 'fastify'
 import jwt from '@fastify/jwt'
 import type { DB } from './db.js'
 import type { EmbeddingProvider } from './embedding.js'
 import { ok, fail } from './reply.js'
 import { findUserRowByName } from './dao/users.js'
 import { verifyPassword } from './crypto.js'
 import { authenticate, type JwtClaims } from './auth.js'
 import { registerMemoryRoutes } from './routes/memory.js'
+import { registerAdminRoutes } from './routes/admin.js'
+import { registerModelConfigRoutes } from './routes/model-config.js'
 
 export interface Deps { db: DB; embed: EmbeddingProvider }
 
 export function buildApp(deps: Deps): FastifyInstance {
   const app = Fastify({ logger: false })
   app.decorate('deps', deps)
   app.register(jwt, { secret: process.env.ECHO_SERVER_SECRET ?? 'dev-secret' })
   app.decorate('authenticate', authenticate)
 
   app.post('/api/auth/login', async (req, reply) => {
@@ -21,13 +23,15 @@ export function buildApp(deps: Deps): FastifyInstance {
     if (!username || !password) return reply.send(fail(1001, '缺少用户名或密码'))
     const row = findUserRowByName(deps.db, username)
     if (!row || row.disabled) return reply.send(fail(1002, '用户不存在或已禁用'))
     if (!(await verifyPassword(row.password_hash, password))) return reply.send(fail(1003, '密码错误'))
     const claims: JwtClaims = { sub: row.id, role: row.role, groupId: row.group_id }
     const token = app.jwt.sign(claims, { expiresIn: '7d' })
     return reply.send(ok({ token, user: { id: row.id, username: row.username, role: row.role, groupId: row.group_id } }))
   })
 
   registerMemoryRoutes(app)
+  registerAdminRoutes(app)
+  registerModelConfigRoutes(app)
 
   return app
 }
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
diff --git a/src/routes/model-config.ts b/src/routes/model-config.ts
new file mode 100644
index 0000000..06d0aaa
--- /dev/null
+++ b/src/routes/model-config.ts
@@ -0,0 +1,36 @@
+import type { FastifyInstance } from 'fastify'
+import { ok } from '../reply.js'
+import { encryptSecret } from '../crypto.js'
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
+  app.put('/api/admin/model-config', { preHandler: [app.authenticate, requireAdminInline] }, async (req, reply) => {
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
+
+// 局部 admin 校验(避免循环 import;与 auth.requireAdmin 同逻辑)
+async function requireAdminInline(req: any, reply: any): Promise<void> {
+  if (req.user?.role !== 'admin') reply.code(403).send({ code: 4031, msg: '需要管理员权限', data: null })
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
