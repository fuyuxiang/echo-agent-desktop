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

