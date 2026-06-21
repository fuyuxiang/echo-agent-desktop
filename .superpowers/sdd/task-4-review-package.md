9bb2a66 feat: 用户与组的数据访问层
---
 src/dao/groups.ts | 14 ++++++++++++++
 src/dao/users.ts  | 53 +++++++++++++++++++++++++++++++++++++++++++++++++++++
 test/dao.test.ts  | 44 ++++++++++++++++++++++++++++++++++++++++++++
 3 files changed, 111 insertions(+)
---
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
