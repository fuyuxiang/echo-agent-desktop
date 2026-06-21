265f296 feat: 项目记忆 DAO(向量检索 + group_id 强隔离)
---
 src/dao/memories.ts   | 116 ++++++++++++++++++++++++++++++++++++++++++++++++++
 test/memories.test.ts |  43 +++++++++++++++++++
 2 files changed, 159 insertions(+)
---
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
