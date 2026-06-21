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

