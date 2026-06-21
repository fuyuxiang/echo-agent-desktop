8022006 fix: requireAdmin preHandler 添加 return 中断请求链
855d374 feat: Fastify 应用骨架与 JWT 登录鉴权
---
 src/app.ts        | 30 ++++++++++++++++++++++++++++++
 src/auth.ts       | 19 +++++++++++++++++++
 src/types.d.ts    | 13 +++++++++++++
 test/auth.test.ts | 25 +++++++++++++++++++++++++
 4 files changed, 87 insertions(+)
---
diff --git a/src/app.ts b/src/app.ts
new file mode 100644
index 0000000..78376ab
--- /dev/null
+++ b/src/app.ts
@@ -0,0 +1,30 @@
+import Fastify, { type FastifyInstance } from 'fastify'
+import jwt from '@fastify/jwt'
+import type { DB } from './db.js'
+import type { EmbeddingProvider } from './embedding.js'
+import { ok, fail } from './reply.js'
+import { findUserRowByName } from './dao/users.js'
+import { verifyPassword } from './crypto.js'
+import { authenticate, type JwtClaims } from './auth.js'
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
