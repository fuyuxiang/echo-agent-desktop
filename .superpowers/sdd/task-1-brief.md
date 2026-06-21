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

