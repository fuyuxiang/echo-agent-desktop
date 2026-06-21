### Task 9: 模型配置路由 + 管理路由(users/groups/model-config)

**Files:**
- Create: `src/routes/admin.ts`, `src/routes/model-config.ts`
- Modify: `src/app.ts`
- Test: `test/admin-routes.test.ts`

**Interfaces:**
- Consumes: DAO (T4), `crypto` (T3), `requireAdmin` (T7)
- Produces:
  - `GET /api/model-config`(任意登录用户)→ `ok({baseUrl, modelName, allowLocalOverride})`(不下发凭证明文;仅当存在凭证时返回 `hasCredential:true`)
  - `PUT /api/admin/model-config {baseUrl,modelName,credential?,allowLocalOverride}`(admin)
  - `GET/POST /api/admin/users`、`PATCH /api/admin/users/:id {groupId?,disabled?}`(admin)
  - `GET/POST /api/admin/groups`(admin)

- [ ] **Step 1: 写失败测试 test/admin-routes.test.ts**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { getDb, type DB } from '../src/db.js'
import { hashEmbedding } from '../src/embedding.js'
import { createUser } from '../src/dao/users.js'
import { buildApp } from '../src/app.js'

process.env.ECHO_SERVER_SECRET = 'test-secret-key-32-bytes-long!!'
let db: DB
const embed = { embed: async (t: string) => hashEmbedding(t) }
beforeEach(() => { db = getDb(':memory:') })

async function login(app: any, u: string, p: string) {
  return (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } })).json().data.token
}

describe('admin & model-config routes', () => {
  it('admin creates group+user, member cannot', async () => {
    await createUser(db, { username: 'root', password: 'pw', role: 'admin', groupId: null })
    const app = buildApp({ db, embed })
    const t = await login(app, 'root', 'pw')
    const g = await app.inject({ method: 'POST', url: '/api/admin/groups', headers: { authorization: `Bearer ${t}` }, payload: { name: '研发' } })
    expect(g.json().code).toBe(0)
    await app.inject({ method: 'POST', url: '/api/admin/users', headers: { authorization: `Bearer ${t}` }, payload: { username: 'm', password: 'pw', role: 'member', groupId: g.json().data.id } })
    const tm = await login(app, 'm', 'pw')
    const denied = await app.inject({ method: 'POST', url: '/api/admin/groups', headers: { authorization: `Bearer ${tm}` }, payload: { name: 'x' } })
    expect(denied.statusCode).toBe(403)
  })

  it('model-config hides credential plaintext', async () => {
    await createUser(db, { username: 'root', password: 'pw', role: 'admin', groupId: null })
    const app = buildApp({ db, embed })
    const t = await login(app, 'root', 'pw')
    await app.inject({ method: 'PUT', url: '/api/admin/model-config', headers: { authorization: `Bearer ${t}` }, payload: { baseUrl: 'https://api.x', modelName: 'gpt', credential: 'sk-secret', allowLocalOverride: false } })
    const got = await app.inject({ method: 'GET', url: '/api/model-config', headers: { authorization: `Bearer ${t}` } })
    expect(JSON.stringify(got.json())).not.toContain('sk-secret')
    expect(got.json().data.hasCredential).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test test/admin-routes.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 src/routes/model-config.ts**

```ts
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { ok } from '../reply.js'
import { encryptSecret } from '../crypto.js'

const ROW_ID = 'org-default'

export function registerModelConfigRoutes(app: FastifyInstance): void {
  const { db } = app.deps

  app.get('/api/model-config', { preHandler: app.authenticate }, async (_req, reply) => {
    const row = db.prepare('SELECT * FROM model_configs WHERE id = ?').get(ROW_ID) as any
    if (!row) return reply.send(ok({ baseUrl: null, modelName: null, allowLocalOverride: true, hasCredential: false }))
    return reply.send(ok({
      baseUrl: row.base_url, modelName: row.model_name,
      allowLocalOverride: !!row.allow_local_override, hasCredential: !!row.credential
    }))
  })

  app.put('/api/model-config'.replace('model-config', 'admin/model-config'), { preHandler: [app.authenticate, requireAdminInline] }, async (req, reply) => {
    const { baseUrl, modelName, credential, allowLocalOverride } = (req.body ?? {}) as any
    const enc = credential ? encryptSecret(credential) : null
    db.prepare(`
      INSERT INTO model_configs (id, scope, base_url, model_name, credential, allow_local_override, updated_at)
      VALUES (?, 'org', ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET base_url=excluded.base_url, model_name=excluded.model_name,
        credential=COALESCE(excluded.credential, model_configs.credential),
        allow_local_override=excluded.allow_local_override, updated_at=excluded.updated_at
    `).run(ROW_ID, baseUrl ?? null, modelName ?? null, enc, allowLocalOverride ? 1 : 0, Date.now())
    return reply.send(ok({ updated: true }))
  })
}

// 局部 admin 校验(避免循环 import;与 auth.requireAdmin 同逻辑)
async function requireAdminInline(req: any, reply: any): Promise<void> {
  if (req.user?.role !== 'admin') reply.code(403).send({ code: 4031, msg: '需要管理员权限', data: null })
}
```

> 注:上面 `.replace(...)` 仅为说明路径,实现时直接写字符串路由 `'/api/admin/model-config'`。请用字面量 `app.put('/api/admin/model-config', ...)`,不要保留 replace 调用。

- [ ] **Step 4: 实现 src/routes/admin.ts**

```ts
import type { FastifyInstance } from 'fastify'
import { ok, fail } from '../reply.js'
import { requireAdmin } from '../auth.js'
import { createGroup, listGroups } from '../dao/groups.js'
import { createUser, listUsers, setUserGroup, setUserDisabled, findUserByName } from '../dao/users.js'

export function registerAdminRoutes(app: FastifyInstance): void {
  const { db } = app.deps
  const guard = { preHandler: [app.authenticate, requireAdmin] }

  app.get('/api/admin/groups', guard, async (_req, reply) => reply.send(ok(listGroups(db))))
  app.post('/api/admin/groups', guard, async (req, reply) => {
    const { name } = (req.body ?? {}) as { name?: string }
    if (!name) return reply.send(fail(1020, '组名不能为空'))
    return reply.send(ok(createGroup(db, name)))
  })

  app.get('/api/admin/users', guard, async (_req, reply) => reply.send(ok(listUsers(db))))
  app.post('/api/admin/users', guard, async (req, reply) => {
    const { username, password, role, groupId } = (req.body ?? {}) as any
    if (!username || !password) return reply.send(fail(1021, '缺少用户名或密码'))
    if (findUserByName(db, username)) return reply.send(fail(1022, '用户名已存在'))
    return reply.send(ok(await createUser(db, { username, password, role: role ?? 'member', groupId: groupId ?? null })))
  })
  app.patch('/api/admin/users/:id', guard, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { groupId, disabled } = (req.body ?? {}) as { groupId?: string; disabled?: boolean }
    if (groupId !== undefined) setUserGroup(db, id, groupId)
    if (disabled !== undefined) setUserDisabled(db, id, disabled)
    return reply.send(ok({ updated: true }))
  })
}
```

- [ ] **Step 5: 在 src/app.ts 注册两个路由模块**

```ts
import { registerAdminRoutes } from './routes/admin.js'
import { registerModelConfigRoutes } from './routes/model-config.js'
// 在 return app 前:
registerAdminRoutes(app)
registerModelConfigRoutes(app)
```

- [ ] **Step 6: 运行确认通过**

Run: `npm test test/admin-routes.test.ts`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add -A && git commit -m "feat: 管理路由与模型配置下发(凭证不明文下发)"
```

---

