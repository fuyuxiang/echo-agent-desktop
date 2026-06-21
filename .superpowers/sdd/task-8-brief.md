### Task 8: 项目记忆路由(write/search/list/delete)

**Files:**
- Modify: `src/app.ts`(注册记忆路由)
- Create: `src/routes/memory.ts`
- Test: `test/memory-routes.test.ts`

**Interfaces:**
- Consumes: `buildApp` deps, `authenticate`, 记忆 DAO (T6)
- Produces(全部需 JWT,group_id 一律取自 `req.user.groupId`):
  - `POST /api/project-memory {content,tags?}` → `ok(Memory)`
  - `POST /api/project-memory/search {query,topK?}` → `ok(Memory[])`
  - `GET /api/project-memory?limit&offset` → `ok(Memory[])`
  - `DELETE /api/project-memory/:id` → `ok({deleted:boolean})`

- [ ] **Step 1: 写失败测试 test/memory-routes.test.ts**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { getDb, type DB } from '../src/db.js'
import { hashEmbedding } from '../src/embedding.js'
import { createGroup } from '../src/dao/groups.js'
import { createUser } from '../src/dao/users.js'
import { buildApp } from '../src/app.js'

process.env.ECHO_SERVER_SECRET = 'test-secret-key-32-bytes-long!!'
let db: DB
const embed = { embed: async (t: string) => hashEmbedding(t) }

async function tokenFor(app: any, username: string, password: string): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } })
  return r.json().data.token
}

beforeEach(() => { db = getDb(':memory:') })

describe('project-memory routes', () => {
  it('writes and searches within own group only', async () => {
    const g1 = createGroup(db, 'g1'); const g2 = createGroup(db, 'g2')
    await createUser(db, { username: 'a', password: 'pw', role: 'member', groupId: g1.id })
    await createUser(db, { username: 'b', password: 'pw', role: 'member', groupId: g2.id })
    const app = buildApp({ db, embed })
    const ta = await tokenFor(app, 'a', 'pw')
    const tb = await tokenFor(app, 'b', 'pw')

    await app.inject({ method: 'POST', url: '/api/project-memory', headers: { authorization: `Bearer ${ta}` }, payload: { content: 'g1 的部署规范' } })

    const sa = await app.inject({ method: 'POST', url: '/api/project-memory/search', headers: { authorization: `Bearer ${ta}` }, payload: { query: '部署规范' } })
    expect(sa.json().data.length).toBeGreaterThanOrEqual(1)

    const sb = await app.inject({ method: 'POST', url: '/api/project-memory/search', headers: { authorization: `Bearer ${tb}` }, payload: { query: '部署规范' } })
    expect(sb.json().data).toHaveLength(0) // b 组看不到 a 组记忆
  })

  it('rejects unauthenticated write', async () => {
    const app = buildApp({ db, embed })
    const res = await app.inject({ method: 'POST', url: '/api/project-memory', payload: { content: 'x' } })
    expect(res.statusCode).toBe(401)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test test/memory-routes.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 src/routes/memory.ts**

```ts
import type { FastifyInstance } from 'fastify'
import { ok, fail } from '../reply.js'
import type { JwtClaims } from '../auth.js'
import { addMemory, searchMemories, listMemories, deleteMemory } from '../dao/memories.js'

export function registerMemoryRoutes(app: FastifyInstance): void {
  const { db, embed } = app.deps

  app.post('/api/project-memory', { preHandler: app.authenticate }, async (req, reply) => {
    const c = req.user as JwtClaims
    if (!c.groupId) return reply.send(fail(1010, '当前用户未分配分组'))
    const { content, tags } = (req.body ?? {}) as { content?: string; tags?: string[] }
    if (!content) return reply.send(fail(1011, '记忆内容不能为空'))
    const mem = await addMemory(db, embed, { groupId: c.groupId, content, tags: tags ?? [], sourceUser: c.sub })
    return reply.send(ok(mem))
  })

  app.post('/api/project-memory/search', { preHandler: app.authenticate }, async (req, reply) => {
    const c = req.user as JwtClaims
    if (!c.groupId) return reply.send(ok([]))
    const { query, topK } = (req.body ?? {}) as { query?: string; topK?: number }
    if (!query) return reply.send(fail(1012, '检索 query 不能为空'))
    const res = await searchMemories(db, embed, { groupId: c.groupId, query, topK: topK ?? 5 })
    return reply.send(ok(res))
  })

  app.get('/api/project-memory', { preHandler: app.authenticate }, async (req, reply) => {
    const c = req.user as JwtClaims
    if (!c.groupId) return reply.send(ok([]))
    const { limit, offset } = (req.query ?? {}) as { limit?: string; offset?: string }
    return reply.send(ok(listMemories(db, { groupId: c.groupId, limit: Number(limit ?? 50), offset: Number(offset ?? 0) })))
  })

  app.delete('/api/project-memory/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const c = req.user as JwtClaims
    if (!c.groupId) return reply.send(fail(1010, '当前用户未分配分组'))
    const { id } = req.params as { id: string }
    return reply.send(ok({ deleted: deleteMemory(db, { groupId: c.groupId, id }) }))
  })
}
```

- [ ] **Step 4: 在 src/app.ts 注册路由**

在 `buildApp` 的 `return app` 之前加:
```ts
import { registerMemoryRoutes } from './routes/memory.js'
// ...
registerMemoryRoutes(app)
```

- [ ] **Step 5: 运行确认通过**

Run: `npm test test/memory-routes.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "feat: 项目记忆 REST 路由(写入/检索/列表/删除,组隔离)"
```

---

