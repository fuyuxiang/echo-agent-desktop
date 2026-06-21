### Task 10: 服务入口与初始管理员引导

**Files:**
- Create: `src/server.ts`
- Create: `README.md`
- Test: `test/bootstrap.test.ts`

**Interfaces:**
- Consumes: 全部
- Produces: `ensureInitialAdmin(db): Promise<void>`(若无任何用户,用 env `ECHO_ADMIN_USER/PASSWORD` 创建首个 admin);`start()`(监听端口)

- [ ] **Step 1: 写失败测试 test/bootstrap.test.ts**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { getDb, type DB } from '../src/db.js'
import { ensureInitialAdmin } from '../src/server.js'
import { listUsers } from '../src/dao/users.js'

let db: DB
beforeEach(() => { db = getDb(':memory:'); process.env.ECHO_ADMIN_USER = 'root'; process.env.ECHO_ADMIN_PASSWORD = 'rootpw' })

describe('initial admin', () => {
  it('creates an admin when db is empty, idempotent', async () => {
    await ensureInitialAdmin(db)
    await ensureInitialAdmin(db)
    const admins = listUsers(db).filter((u) => u.role === 'admin')
    expect(admins).toHaveLength(1)
    expect(admins[0].username).toBe('root')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test test/bootstrap.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 src/server.ts**

```ts
import type { DB } from './db.js'
import { getDb } from './db.js'
import { listUsers, createUser } from './dao/users.js'
import { createEmbeddingProvider } from './embedding.js'
import { buildApp } from './app.js'

export async function ensureInitialAdmin(db: DB): Promise<void> {
  if (listUsers(db).length > 0) return
  const username = process.env.ECHO_ADMIN_USER ?? 'admin'
  const password = process.env.ECHO_ADMIN_PASSWORD ?? 'admin12345'
  await createUser(db, { username, password, role: 'admin', groupId: null })
}

export async function start(): Promise<void> {
  const db = getDb()
  await ensureInitialAdmin(db)
  const app = buildApp({ db, embed: createEmbeddingProvider() })
  const port = Number(process.env.ECHO_SERVER_PORT ?? 8787)
  await app.listen({ port, host: '0.0.0.0' })
  // eslint-disable-next-line no-console
  console.log(`echo-agent-server listening on :${port}`)
}

// 直接运行入口
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  start().catch((e) => { console.error(e); process.exit(1) })
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test test/bootstrap.test.ts`
Expected: PASS

- [ ] **Step 5: 写 README.md(启动说明)**

```markdown
# echo-agent-server

Echo Agent 企业版的项目记忆服务:账号/分组/JWT、项目记忆向量检索(组隔离)、模型配置下发。

## 启动
1. 复制 `.env.example` 为 `.env`,设置 `ECHO_SERVER_SECRET`(>=32 字节)与初始管理员。
2. `npm install && npm run dev`(开发)或 `npm run build && npm start`(生产)。
3. 首启自动用 `ECHO_ADMIN_USER/PASSWORD` 创建超级管理员。

## 向量检索
默认使用确定性 hash 向量(零依赖,可离线)。配置 `ECHO_EMBED_URL/KEY/MODEL`(OpenAI 兼容 `/embeddings`)后切换为真实 embedding。
```

- [ ] **Step 6: 全量测试 + 提交**

Run: `npm test`
Expected: 全部 PASS

```bash
git add -A && git commit -m "feat: 服务入口、初始管理员引导与启动文档"
```

---

## Self-Review

- **Spec 覆盖**:账号(T4,T7,T10)、分组隔离(T6,T8)、项目记忆存取+检索(T6,T8)、模型配置下发+覆盖策略(T9)、统一信封(T1)、安全(T3,T7,T9)、测试策略(各 Task 含组隔离重点测 T8)。全部 spec 第 7 节要点有对应任务。
- **Placeholder**:T9 的 `.replace(...)` 已显式注明实现时改字面量路由,非残留占位。
- **类型一致性**:`JwtClaims{sub,role,groupId}` 在 T7 定义、T8/T9 复用;`Memory` 形状 T6 定义、T8 透传;`groupId` 全链路命名一致。
