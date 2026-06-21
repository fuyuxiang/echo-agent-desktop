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

