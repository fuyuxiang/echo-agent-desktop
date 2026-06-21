# Echo Agent Server (项目记忆服务) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个轻量的项目记忆服务,提供账号/分组/JWT 认证、按组隔离的项目记忆存取与向量检索、组织级模型配置下发。

**Architecture:** 单进程 Node + TypeScript 服务,Fastify 提供 HTTP API,better-sqlite3 存储,sqlite-vec 做向量检索。组隔离在数据层用 `group_id` 字段强制完成(从 JWT 推导,不信任客户端入参)。所有响应统一为 `{code, msg, data}` 信封以匹配桌面客户端的 axios 拦截器。

**Tech Stack:** Node 20+, TypeScript, Fastify, better-sqlite3, sqlite-vec, @fastify/jwt, argon2, vitest, zod。

## Global Constraints

- 代码目录:`/Users/fuyuxiang/Documents/100-主业/130-东方国信/13.代码仓库/echo-agent-server`(下文路径均相对此根)。
- 所有 HTTP 响应体统一为 `{ code: number, msg: string, data: T }`,成功 `code === 0`(与客户端 `SUCCESS_CODE` 一致)。
- 业务错误用 `code !== 0` + HTTP 200 返回;鉴权失败用 HTTP 401。
- 组隔离铁律:任何项目记忆的读/写,`group_id` 一律从 JWT claims 推导,**禁止**从请求体/查询参数读取。
- 密码用 argon2 哈希;模型凭证用 AES-256-GCM 加密落库,密钥从环境变量 `ECHO_SERVER_SECRET` 读取。
- 提交信息只描述改动本身,不加任何署名/前缀/emoji。
- 注释与标识符用英文,文档与提交说明用中文。

---

### Task 1: 项目脚手架与统一响应信封

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`
- Create: `src/reply.ts`(统一信封辅助)
- Test: `test/reply.test.ts`

**Interfaces:**
- Produces: `ok<T>(data: T): {code:0,msg:'ok',data:T}`;`fail(code:number,msg:string): {code,msg,data:null}`

- [ ] **Step 1: 初始化 package.json 与依赖**

```bash
cd "/Users/fuyuxiang/Documents/100-主业/130-东方国信/13.代码仓库/echo-agent-server"
npm init -y
npm pkg set type="module"
npm pkg set scripts.dev="tsx watch src/server.ts"
npm pkg set scripts.build="tsc"
npm pkg set scripts.start="node dist/server.js"
npm pkg set scripts.test="vitest run"
npm install fastify @fastify/jwt better-sqlite3 sqlite-vec argon2 zod
npm install -D typescript tsx vitest @types/node @types/better-sqlite3
```

- [ ] **Step 2: 写 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: 写 .gitignore 与 .env.example**

`.gitignore`:
```
node_modules/
dist/
*.db
.env
```

`.env.example`:
```
ECHO_SERVER_PORT=8787
ECHO_SERVER_SECRET=change-me-32-bytes-min-secret-key
ECHO_SERVER_DB=./data/echo-server.db
ECHO_ADMIN_USER=admin
ECHO_ADMIN_PASSWORD=admin12345
```

- [ ] **Step 4: 写失败测试 test/reply.test.ts**

```ts
import { describe, it, expect } from 'vitest'
import { ok, fail } from '../src/reply.js'

describe('reply envelope', () => {
  it('ok wraps data with code 0', () => {
    expect(ok({ a: 1 })).toEqual({ code: 0, msg: 'ok', data: { a: 1 } })
  })
  it('fail carries code and msg, null data', () => {
    expect(fail(1001, 'bad')).toEqual({ code: 1001, msg: 'bad', data: null })
  })
})
```

- [ ] **Step 5: 运行测试确认失败**

Run: `npm test`
Expected: FAIL,找不到 `src/reply.js`

- [ ] **Step 6: 实现 src/reply.ts**

```ts
export interface Envelope<T> {
  code: number
  msg: string
  data: T
}

export function ok<T>(data: T): Envelope<T> {
  return { code: 0, msg: 'ok', data }
}

export function fail(code: number, msg: string): Envelope<null> {
  return { code, msg, data: null }
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git init && git add -A
git commit -m "chore: 初始化项目记忆服务脚手架与统一响应信封"
```

---

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

### Task 3: 密码哈希与凭证加密工具

**Files:**
- Create: `src/crypto.ts`
- Test: `test/crypto.test.ts`

**Interfaces:**
- Produces: `hashPassword(p:string):Promise<string>`;`verifyPassword(hash:string,p:string):Promise<boolean>`;`encryptSecret(plain:string):string`;`decryptSecret(blob:string):string`

- [ ] **Step 1: 写失败测试 test/crypto.test.ts**

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { hashPassword, verifyPassword, encryptSecret, decryptSecret } from '../src/crypto.js'

beforeAll(() => { process.env.ECHO_SERVER_SECRET = 'test-secret-key-32-bytes-long!!' })

describe('crypto', () => {
  it('verifies a correct password and rejects wrong', async () => {
    const h = await hashPassword('s3cret')
    expect(await verifyPassword(h, 's3cret')).toBe(true)
    expect(await verifyPassword(h, 'wrong')).toBe(false)
  })
  it('round-trips an encrypted secret', () => {
    const blob = encryptSecret('sk-12345')
    expect(blob).not.toContain('sk-12345')
    expect(decryptSecret(blob)).toBe('sk-12345')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test test/crypto.test.ts`
Expected: FAIL,找不到模块

- [ ] **Step 3: 实现 src/crypto.ts**

```ts
import argon2 from 'argon2'
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain)
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain)
  } catch {
    return false
  }
}

function key(): Buffer {
  const secret = process.env.ECHO_SERVER_SECRET
  if (!secret) throw new Error('ECHO_SERVER_SECRET not set')
  return createHash('sha256').update(secret).digest()
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.')
}

export function decryptSecret(blob: string): string {
  const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'))
  const decipher = createDecipheriv('aes-256-gcm', key(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test test/crypto.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: 密码 argon2 哈希与凭证 AES-256-GCM 加密工具"
```

---

### Task 4: 用户与组数据访问层(DAO)

**Files:**
- Create: `src/dao/users.ts`, `src/dao/groups.ts`
- Test: `test/dao.test.ts`

**Interfaces:**
- Consumes: `getDb` (Task 2), `hashPassword` (Task 3)
- Produces:
  - `createUser(db, {username, password, role, groupId}): Promise<User>`
  - `findUserByName(db, username): User | undefined`
  - `setUserGroup(db, userId, groupId): void`;`setUserDisabled(db, userId, disabled): void`;`listUsers(db): User[]`
  - `createGroup(db, name): Group`;`listGroups(db): Group[]`
  - `User = {id,username,role:'member'|'admin',groupId:string|null,disabled:boolean}`(不含 password_hash);`Group = {id,name,createdAt}`

- [ ] **Step 1: 写失败测试 test/dao.test.ts**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { getDb, type DB } from '../src/db.js'
import { createUser, findUserByName, listUsers, setUserGroup } from '../src/dao/users.js'
import { createGroup, listGroups } from '../src/dao/groups.js'

let db: DB
beforeEach(() => { db = getDb(':memory:') })

describe('users & groups dao', () => {
  it('creates a group and a user assigned to it', async () => {
    const g = createGroup(db, '研发组')
    expect(listGroups(db)).toHaveLength(1)
    const u = await createUser(db, { username: 'alice', password: 'pw', role: 'member', groupId: g.id })
    expect(u.username).toBe('alice')
    expect((u as any).password_hash).toBeUndefined()
    expect(findUserByName(db, 'alice')?.groupId).toBe(g.id)
  })
  it('moves a user to another group', async () => {
    const g1 = createGroup(db, 'a'); const g2 = createGroup(db, 'b')
    const u = await createUser(db, { username: 'bob', password: 'pw', role: 'member', groupId: g1.id })
    setUserGroup(db, u.id, g2.id)
    expect(findUserByName(db, 'bob')?.groupId).toBe(g2.id)
    expect(listUsers(db)).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test test/dao.test.ts`
Expected: FAIL,找不到 dao 模块

- [ ] **Step 3: 实现 src/dao/groups.ts**

```ts
import { randomUUID } from 'node:crypto'
import type { DB } from '../db.js'

export interface Group { id: string; name: string; createdAt: number }

export function createGroup(db: DB, name: string): Group {
  const g: Group = { id: randomUUID(), name, createdAt: Date.now() }
  db.prepare('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(g.id, g.name, g.createdAt)
  return g
}

export function listGroups(db: DB): Group[] {
  return db.prepare('SELECT id, name, created_at as createdAt FROM groups ORDER BY created_at').all() as Group[]
}
```

- [ ] **Step 4: 实现 src/dao/users.ts**

```ts
import { randomUUID } from 'node:crypto'
import type { DB } from '../db.js'
import { hashPassword } from '../crypto.js'

export interface User {
  id: string
  username: string
  role: 'member' | 'admin'
  groupId: string | null
  disabled: boolean
}

interface UserRow {
  id: string; username: string; password_hash: string
  role: 'member' | 'admin'; group_id: string | null; disabled: number
}

function toUser(r: UserRow): User {
  return { id: r.id, username: r.username, role: r.role, groupId: r.group_id, disabled: !!r.disabled }
}

export async function createUser(
  db: DB,
  input: { username: string; password: string; role: 'member' | 'admin'; groupId: string | null }
): Promise<User> {
  const id = randomUUID()
  const hash = await hashPassword(input.password)
  db.prepare(
    'INSERT INTO users (id, username, password_hash, role, group_id, disabled, created_at) VALUES (?,?,?,?,?,0,?)'
  ).run(id, input.username, hash, input.role, input.groupId, Date.now())
  return { id, username: input.username, role: input.role, groupId: input.groupId, disabled: false }
}

export function findUserRowByName(db: DB, username: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined
}

export function findUserByName(db: DB, username: string): User | undefined {
  const r = findUserRowByName(db, username)
  return r ? toUser(r) : undefined
}

export function listUsers(db: DB): User[] {
  return (db.prepare('SELECT * FROM users ORDER BY created_at').all() as UserRow[]).map(toUser)
}

export function setUserGroup(db: DB, userId: string, groupId: string): void {
  db.prepare('UPDATE users SET group_id = ? WHERE id = ?').run(groupId, userId)
}

export function setUserDisabled(db: DB, userId: string, disabled: boolean): void {
  db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, userId)
}
```

- [ ] **Step 5: 运行确认通过**

Run: `npm test test/dao.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "feat: 用户与组的数据访问层"
```

---

### Task 5: Embedding 提供者(可注入,默认确定性桩)

**Files:**
- Create: `src/embedding.ts`
- Test: `test/embedding.test.ts`

**Interfaces:**
- Produces: `EmbeddingProvider = { embed(text: string): Promise<number[]> }`;`createEmbeddingProvider(): EmbeddingProvider`(读 `ECHO_EMBED_URL`/`ECHO_EMBED_KEY`/`ECHO_EMBED_MODEL`;未配置时返回 `hashEmbedding` 桩);`hashEmbedding(text, dim=1024): number[]`(确定性,L2 归一化)

> 设计说明:服务器本身不绑定具体大模型。生产用 OpenAI 兼容 `/embeddings` 接口(由 env 配置);未配置时用确定性 hash 向量桩,保证可独立测试与离线开发。维度固定 1024,与 Task 2 的 vec 虚表一致。

- [ ] **Step 1: 写失败测试 test/embedding.test.ts**

```ts
import { describe, it, expect } from 'vitest'
import { hashEmbedding } from '../src/embedding.js'

describe('hashEmbedding', () => {
  it('is deterministic and correct length', () => {
    const a = hashEmbedding('hello', 1024)
    const b = hashEmbedding('hello', 1024)
    expect(a).toHaveLength(1024)
    expect(a).toEqual(b)
  })
  it('differs for different text', () => {
    expect(hashEmbedding('a')).not.toEqual(hashEmbedding('b'))
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test test/embedding.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 src/embedding.ts**

```ts
import { createHash } from 'node:crypto'

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>
}

export function hashEmbedding(text: string, dim = 1024): number[] {
  const vec = new Array<number>(dim).fill(0)
  // 用滚动 hash 把 token 散布到各维度,得到确定性伪向量
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean)
  for (const tok of tokens) {
    const h = createHash('md5').update(tok).digest()
    for (let i = 0; i < h.length; i++) {
      vec[(h[i] + i * 31) % dim] += (h[i] - 128) / 128
    }
  }
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1
  return vec.map((x) => x / norm)
}

export function createEmbeddingProvider(): EmbeddingProvider {
  const url = process.env.ECHO_EMBED_URL
  const k = process.env.ECHO_EMBED_KEY
  const model = process.env.ECHO_EMBED_MODEL ?? 'text-embedding-3-small'
  if (!url || !k) {
    return { embed: async (t) => hashEmbedding(t) }
  }
  return {
    async embed(text: string): Promise<number[]> {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${k}` },
        body: JSON.stringify({ model, input: text })
      })
      const json = (await res.json()) as { data: { embedding: number[] }[] }
      return json.data[0].embedding
    }
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test test/embedding.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: 可注入的 embedding 提供者(默认确定性向量桩)"
```

---

### Task 6: 项目记忆 DAO(写入 + 向量检索 + 组隔离)

**Files:**
- Create: `src/dao/memories.ts`
- Test: `test/memories.test.ts`

**Interfaces:**
- Consumes: `getDb` (Task 2), `EmbeddingProvider` (Task 5)
- Produces:
  - `addMemory(db, embed, {groupId, content, tags, sourceUser}): Promise<Memory>`
  - `searchMemories(db, embed, {groupId, query, topK}): Promise<Memory[]>`(仅返回该 groupId 的记忆)
  - `listMemories(db, {groupId, limit, offset}): Memory[]`;`deleteMemory(db, {groupId, id}): boolean`
  - `Memory = {id,groupId,content,tags:string[],sourceUser,createdAt,updatedAt}`

- [ ] **Step 1: 写失败测试 test/memories.test.ts**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { getDb, type DB } from '../src/db.js'
import { hashEmbedding } from '../src/embedding.js'
import { addMemory, searchMemories, listMemories, deleteMemory } from '../src/dao/memories.js'

const embed = { embed: async (t: string) => hashEmbedding(t) }
let db: DB
beforeEach(() => { db = getDb(':memory:') })

describe('project memory dao', () => {
  it('search only returns memories of the same group', async () => {
    await addMemory(db, embed, { groupId: 'g1', content: '部署流程用 k8s', tags: [], sourceUser: 'u1' })
    await addMemory(db, embed, { groupId: 'g2', content: '部署流程用 k8s', tags: [], sourceUser: 'u2' })
    const res = await searchMemories(db, embed, { groupId: 'g1', query: '部署流程', topK: 5 })
    expect(res.length).toBeGreaterThanOrEqual(1)
    expect(res.every((m) => m.groupId === 'g1')).toBe(true)
  })
  it('lists and deletes within group scope', async () => {
    const m = await addMemory(db, embed, { groupId: 'g1', content: 'x', tags: ['a'], sourceUser: 'u1' })
    expect(listMemories(db, { groupId: 'g1', limit: 10, offset: 0 })).toHaveLength(1)
    expect(deleteMemory(db, { groupId: 'g2', id: m.id })).toBe(false) // 跨组删不掉
    expect(deleteMemory(db, { groupId: 'g1', id: m.id })).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test test/memories.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 src/dao/memories.ts**

```ts
import { randomUUID } from 'node:crypto'
import type { DB } from '../db.js'
import type { EmbeddingProvider } from '../embedding.js'

export interface Memory {
  id: string; groupId: string; content: string
  tags: string[]; sourceUser: string; createdAt: number; updatedAt: number
}

interface Row {
  id: string; group_id: string; content: string
  tags: string; source_user: string; created_at: number; updated_at: number
}

function toMem(r: Row): Memory {
  return {
    id: r.id, groupId: r.group_id, content: r.content,
    tags: JSON.parse(r.tags), sourceUser: r.source_user,
    createdAt: r.created_at, updatedAt: r.updated_at
  }
}

export async function addMemory(
  db: DB, embed: EmbeddingProvider,
  input: { groupId: string; content: string; tags: string[]; sourceUser: string }
): Promise<Memory> {
  const id = randomUUID()
  const now = Date.now()
  db.prepare(
    'INSERT INTO project_memories (id, group_id, content, tags, source_user, created_at, updated_at) VALUES (?,?,?,?,?,?,?)'
  ).run(id, input.groupId, input.content, JSON.stringify(input.tags), input.sourceUser, now, now)
  const vec = await embed.embed(input.content)
  db.prepare('INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)').run(id, new Float32Array(vec))
  return { id, groupId: input.groupId, content: input.content, tags: input.tags, sourceUser: input.sourceUser, createdAt: now, updatedAt: now }
}

export async function searchMemories(
  db: DB, embed: EmbeddingProvider,
  input: { groupId: string; query: string; topK: number }
): Promise<Memory[]> {
  const vec = await embed.embed(input.query)
  // 先按向量距离取候选,再用 group_id 过滤(JOIN 强制组隔离)
  const rows = db.prepare(`
    SELECT p.* FROM vec_memories v
    JOIN project_memories p ON p.id = v.memory_id
    WHERE v.embedding MATCH ? AND p.group_id = ? AND k = ?
    ORDER BY v.distance
  `).all(new Float32Array(vec), input.groupId, input.topK) as Row[]
  return rows.map(toMem)
}

export function listMemories(db: DB, input: { groupId: string; limit: number; offset: number }): Memory[] {
  const rows = db.prepare(
    'SELECT * FROM project_memories WHERE group_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(input.groupId, input.limit, input.offset) as Row[]
  return rows.map(toMem)
}

export function deleteMemory(db: DB, input: { groupId: string; id: string }): boolean {
  const res = db.prepare('DELETE FROM project_memories WHERE id = ? AND group_id = ?').run(input.id, input.groupId)
  if (res.changes > 0) {
    db.prepare('DELETE FROM vec_memories WHERE memory_id = ?').run(input.id)
    return true
  }
  return false
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test test/memories.test.ts`
Expected: PASS(若 sqlite-vec 的 `k = ?` 语法在版本上有差异,改为 `v.embedding MATCH ? AND k = ?` 子查询取 memory_id 再 JOIN 过滤 group)

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: 项目记忆 DAO(向量检索 + group_id 强隔离)"
```

---

### Task 7: Fastify 应用与 JWT 鉴权装饰器

**Files:**
- Create: `src/app.ts`
- Create: `src/auth.ts`
- Test: `test/auth.test.ts`

**Interfaces:**
- Consumes: `getDb` (T2), DAO (T4), `verifyPassword` (T3), `ok/fail` (T1)
- Produces:
  - `buildApp(deps: {db, embed}): FastifyInstance`(注册 @fastify/jwt、`authenticate` 与 `requireAdmin` preHandler、登录路由)
  - JWT claims 形状:`{ sub: userId, role, groupId }`
  - 登录路由:`POST /api/auth/login {username,password}` → `ok({token, user})`

- [ ] **Step 1: 写失败测试 test/auth.test.ts**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { getDb, type DB } from '../src/db.js'
import { hashEmbedding } from '../src/embedding.js'
import { createGroup } from '../src/dao/groups.js'
import { createUser } from '../src/dao/users.js'
import { buildApp } from '../src/app.js'

process.env.ECHO_SERVER_SECRET = 'test-secret-key-32-bytes-long!!'
let db: DB
beforeEach(() => { db = getDb(':memory:') })

describe('auth', () => {
  it('logs in with correct credentials and rejects wrong', async () => {
    const g = createGroup(db, 'g1')
    await createUser(db, { username: 'alice', password: 'pw', role: 'member', groupId: g.id })
    const app = buildApp({ db, embed: { embed: async (t) => hashEmbedding(t) } })

    const okRes = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'pw' } })
    expect(okRes.json().code).toBe(0)
    expect(okRes.json().data.token).toBeTypeOf('string')

    const badRes = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'no' } })
    expect(badRes.json().code).not.toBe(0)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test test/auth.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 src/auth.ts**

```ts
import type { FastifyReply, FastifyRequest } from 'fastify'
import { fail } from './reply.js'

export interface JwtClaims { sub: string; role: 'member' | 'admin'; groupId: string | null }

export async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await req.jwtVerify()
  } catch {
    reply.code(401).send(fail(4011, '未认证或登录已过期'))
  }
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const claims = req.user as JwtClaims
  if (claims?.role !== 'admin') {
    reply.code(403).send(fail(4031, '需要管理员权限'))
  }
}
```

- [ ] **Step 4: 实现 src/app.ts**

```ts
import Fastify, { type FastifyInstance } from 'fastify'
import jwt from '@fastify/jwt'
import type { DB } from './db.js'
import type { EmbeddingProvider } from './embedding.js'
import { ok, fail } from './reply.js'
import { findUserRowByName } from './dao/users.js'
import { verifyPassword } from './crypto.js'
import { authenticate, type JwtClaims } from './auth.js'

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

  return app
}
```

> 注:`app.inject` 中 `req.user` 由 @fastify/jwt 在 `jwtVerify` 后填充。TypeScript 需在 `src/types.d.ts` 声明模块扩展(下一步)。

- [ ] **Step 5: 补 src/types.d.ts(模块扩展)**

```ts
import type { Deps } from './app.js'
declare module 'fastify' {
  interface FastifyInstance {
    deps: Deps
    authenticate: (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>
  }
}
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; role: 'member' | 'admin'; groupId: string | null }
    user: { sub: string; role: 'member' | 'admin'; groupId: string | null }
  }
}
```

- [ ] **Step 6: 运行确认通过**

Run: `npm test test/auth.test.ts`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add -A && git commit -m "feat: Fastify 应用骨架与 JWT 登录鉴权"
```

---

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
