# Echo Agent Desktop (客户端) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `echo-desktop` 脚手架基础上,实现"本地内置 echo-agent 推理 + 个人记忆本地 + 项目记忆走服务器(组隔离)+ 记忆分流确认 + 模型配置 A/B 双来源 + 登录与管理"的 P0 功能。

**Architecture:** Electron 主进程已具备 echo-agent 进程管理(`agent-process`)、HTTP 代理(`agent.httpProxy`)、加密存储(`store.secure`)。本期在渲染层新增 server-connector(经 axios + JWT 调 echo-agent-server)、登录/用户态、项目记忆编排(检索注入 + 写入确认)、记忆区视图、设置页模型配置、管理页;主进程侧扩展配置生成以支持服务端下发的模型配置。

**Tech Stack:** Electron 41, electron-vite, React 18, TypeScript, zustand, axios, react-hook-form + zod, ahooks, react-virtuoso, i18next。

## Global Constraints

- 客户端代码目录:`/Users/fuyuxiang/Documents/100-主业/130-东方国信/13.代码仓库/echo-agent-desktop`。**起点**:把上级 `echo-desktop` 脚手架内容拷入本目录作为基线(Task 1)。
- Electron 固定 41.x(better-sqlite3 与 Electron ≥42 编译不兼容),不升级。
- 遵守脚手架规范(`docs/PAGE_GUIDE.md`):页面只碰 `pages/ services/ mock/`;基建(`main/ preload/ utils/ request/`)只调不改,确需扩展时按"types→main handler→preload→utils 门面"链路补全。
- 禁止散落 URL 字符串(收口 `request/urls.ts`);禁止直接用 `window.api`(走 `@/utils` 门面);禁止 localStorage(走 `storage`/persist);禁止手写 IPC channel(用 `shared/ipc-channels.ts` 常量)。
- 服务器响应为 `{code,msg,data}`,`code===0` 成功;axios 拦截器已自动解包并按 token(`storage.secure.get('token')`)注入 Authorization。
- 文案不写死,进 `i18n/locales/zh-CN.json` + `en-US.json`,组件用 `t('xxx.yyy')`,默认中文。
- 提交信息只描述改动本身,不加任何署名/前缀/emoji;注释与标识符英文,文档与提交中文。

---

### Task 1: 基线导入与服务器地址配置

**Files:**
- Create: 整个客户端基线(从 `echo-desktop` 拷入)
- Modify: `.env`(新增 `VITE_API_BASE_URL`)
- Modify: `src/renderer/src/request/urls.ts`(确认 host 来源)

**Interfaces:**
- Produces: 可 `npm run dev` 启动的脚手架基线;`API_HOST` 指向 echo-agent-server。

- [ ] **Step 1: 拷入脚手架基线**

```bash
cd "/Users/fuyuxiang/Documents/100-主业/130-东方国信/13.代码仓库/echo-agent-desktop"
rsync -a --exclude node_modules --exclude out --exclude dist "../echo-desktop/" ./
npm install
```

- [ ] **Step 2: 验证基线可构建**

Run: `npm run typecheck`
Expected: 通过(无类型错误)

- [ ] **Step 3: 配置服务器地址**

在 `.env`(无则新建)追加:
```
VITE_API_BASE_URL=http://127.0.0.1:8787
VITE_USE_MOCK=false
```

- [ ] **Step 4: 提交**

```bash
git init && git add -A
git commit -m "chore: 导入桌面客户端脚手架基线并配置服务器地址"
```

---

### Task 2: server-connector 服务层(登录 + 用户态接口)

**Files:**
- Create: `src/renderer/src/services/server.ts`
- Modify: `src/renderer/src/request/urls.ts`(新增 `ServerApiUrls`)
- Create: `src/renderer/src/mock/server.ts`
- Test: `src/renderer/src/services/__tests__/server.test.ts`

**Interfaces:**
- Produces:
  - `login(username,password): Promise<{token:string; user:ServerUser}>`
  - `fetchModelConfig(): Promise<ModelConfigDTO>`
  - `ServerUser = {id,username,role:'member'|'admin',groupId:string|null}`
  - `ModelConfigDTO = {baseUrl:string|null,modelName:string|null,allowLocalOverride:boolean,hasCredential:boolean}`

> 说明:脚手架已有 axios 封装(`request`)与拦截器(自动解包 + 注入 token)。services 层只声明 URL 常量与类型化请求函数,符合 PAGE_GUIDE「services 只引用 urls」。需先确认有 vitest;若脚手架未配置测试,本 Task Step 0 添加。

- [ ] **Step 0: 确认/添加 vitest(仅首次)**

```bash
cat package.json | grep -q '"vitest"' || npm install -D vitest
npm pkg set scripts.test="vitest run"
```
若新增,创建 `vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
import path from 'node:path'
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src/renderer/src'), '@shared': path.resolve(__dirname, 'src/shared') } },
  test: { environment: 'node' }
})
```

- [ ] **Step 1: 在 urls.ts 增加 ServerApiUrls**

在 `src/renderer/src/request/urls.ts` 末尾追加:
```ts
/** echo-agent-server(项目记忆服务)API 路径 */
export const ServerApiUrls = {
  login: '/api/auth/login',
  modelConfig: '/api/model-config',
  projectMemory: '/api/project-memory',
  projectMemorySearch: '/api/project-memory/search',
  adminUsers: '/api/admin/users',
  adminGroups: '/api/admin/groups',
  adminModelConfig: '/api/admin/model-config'
}
```

- [ ] **Step 2: 写失败测试 services/__tests__/server.test.ts**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { login } from '../server'
import { request } from '@/request'

vi.mock('@/request', () => ({ request: { post: vi.fn(), get: vi.fn() } }))

describe('server service', () => {
  beforeEach(() => vi.clearAllMocks())
  it('login posts credentials and returns token+user', async () => {
    ;(request.post as any).mockResolvedValue({ token: 't1', user: { id: 'u1', username: 'a', role: 'member', groupId: 'g1' } })
    const res = await login('a', 'pw')
    expect(request.post).toHaveBeenCalledWith('/api/auth/login', { username: 'a', password: 'pw' })
    expect(res.token).toBe('t1')
    expect(res.user.groupId).toBe('g1')
  })
})
```

- [ ] **Step 3: 运行确认失败**

Run: `npm test src/renderer/src/services/__tests__/server.test.ts`
Expected: FAIL,找不到 `../server`

- [ ] **Step 4: 实现 services/server.ts**

```ts
import { request } from '@/request'
import { ServerApiUrls } from '@/request/urls'

export interface ServerUser {
  id: string
  username: string
  role: 'member' | 'admin'
  groupId: string | null
}

export interface ModelConfigDTO {
  baseUrl: string | null
  modelName: string | null
  allowLocalOverride: boolean
  hasCredential: boolean
}

export function login(username: string, password: string): Promise<{ token: string; user: ServerUser }> {
  return request.post<{ token: string; user: ServerUser }>(ServerApiUrls.login, { username, password })
}

export function fetchModelConfig(): Promise<ModelConfigDTO> {
  return request.get<ModelConfigDTO>(ServerApiUrls.modelConfig)
}
```

- [ ] **Step 5: 运行确认通过**

Run: `npm test src/renderer/src/services/__tests__/server.test.ts`
Expected: PASS

- [ ] **Step 6: 写 mock/server.ts(便于离线联调)**

```ts
import { registerMock } from '@/mock'
import { ServerApiUrls } from '@/request/urls'

registerMock('POST', ServerApiUrls.login, () => ({
  token: 'mock-token',
  user: { id: 'u1', username: 'demo', role: 'admin', groupId: 'g1' }
}))
registerMock('GET', ServerApiUrls.modelConfig, () => ({
  baseUrl: 'https://api.example.com/v1', modelName: 'gpt-4o', allowLocalOverride: false, hasCredential: true
}))
```

- [ ] **Step 7: 提交**

```bash
git add -A && git commit -m "feat: server-connector 登录与模型配置服务"
```

---

### Task 3: 用户态 store 与登录页

**Files:**
- Modify: `src/renderer/src/stores/userStore.ts`
- Create: `src/renderer/src/pages/Login/index.tsx` + `login.module.scss`
- Modify: `src/renderer/src/constants/index.ts`、`src/renderer/src/router/index.tsx`(注册路由)
- Test: `src/renderer/src/stores/__tests__/userStore.test.ts`

**Interfaces:**
- Consumes: `login` (Task 2), `storage.secure` 门面
- Produces:
  - `useUserStore` 增加:`user:ServerUser|null`、`isAuthed:boolean`、`signIn(username,password):Promise<void>`、`signOut():void`
  - 登录成功后:token 存 `storage.secure.set('token', ...)`,user 存 store(persist)

- [ ] **Step 1: 写失败测试 stores/__tests__/userStore.test.ts**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/services/server', () => ({
  login: vi.fn(async () => ({ token: 't1', user: { id: 'u1', username: 'a', role: 'member', groupId: 'g1' } }))
}))
const secureSet = vi.fn()
vi.mock('@/utils', () => ({ storage: { secure: { set: secureSet, get: vi.fn(), remove: vi.fn() } } }))

import { useUserStore } from '../userStore'

describe('userStore auth', () => {
  beforeEach(() => { useUserStore.setState({ user: null }); secureSet.mockClear() })
  it('signIn stores token securely and sets user', async () => {
    await useUserStore.getState().signIn('a', 'pw')
    expect(secureSet).toHaveBeenCalledWith('token', 't1')
    expect(useUserStore.getState().user?.groupId).toBe('g1')
    expect(useUserStore.getState().isAuthed).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test src/renderer/src/stores/__tests__/userStore.test.ts`
Expected: FAIL（signIn 未定义 / isAuthed 未定义）

- [ ] **Step 3: 扩展 userStore.ts**

在现有 `useUserStore` 基础上加入(保持原有字段;`isAuthed` 用 getter 形式存为派生字段):
```ts
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { storage } from '@/utils'
import { login as apiLogin, type ServerUser } from '@/services/server'
import { electronStoreStorage } from './persist-storage'

interface UserState {
  user: ServerUser | null
  isAuthed: boolean
  signIn: (username: string, password: string) => Promise<void>
  signOut: () => void
}

export const useUserStore = create<UserState>()(
  persist(
    (set) => ({
      user: null,
      isAuthed: false,
      async signIn(username, password) {
        const { token, user } = await apiLogin(username, password)
        await storage.secure.set('token', token)
        set({ user, isAuthed: true })
      },
      signOut() {
        storage.secure.remove('token')
        set({ user: null, isAuthed: false })
      }
    }),
    { name: 'user-store', storage: electronStoreStorage, partialize: (s) => ({ user: s.user, isAuthed: s.isAuthed }) }
  )
)
```
> 若现有 `userStore.ts` 已有 `UserInfo` 字段,合并而非覆盖:保留旧字段,新增上述三项。`electronStoreStorage` 与 `persist-storage.ts` 的导出名以脚手架现状为准(打开该文件确认导出名后引用)。

- [ ] **Step 4: 运行确认通过**

Run: `npm test src/renderer/src/stores/__tests__/userStore.test.ts`
Expected: PASS

- [ ] **Step 5: 生成登录页骨架**

```bash
npm run new:page
# 输入 Login
```

- [ ] **Step 6: 实现 pages/Login/index.tsx**

```tsx
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useUserStore } from '@/stores/userStore'
import { toast } from '@/components/Toast'
import styles from './login.module.scss'

export default function Login(): JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const signIn = useUserStore((s) => s.signIn)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setLoading(true)
    try {
      await signIn(username, password)
      navigate('/chat')
    } catch {
      // 业务错误已由拦截器 toast
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.wrap}>
      <form className={styles.card} onSubmit={onSubmit}>
        <h1>{t('login.title')}</h1>
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder={t('login.username')} />
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('login.password')} />
        <button disabled={loading || !username || !password}>{t('login.submit')}</button>
      </form>
    </div>
  )
}
```

- [ ] **Step 7: 加 i18n 文案**

`i18n/locales/zh-CN.json` 增加:
```json
"login": { "title": "登录 Echo Agent", "username": "用户名", "password": "密码", "submit": "登录" }
```
`en-US.json` 增加对应英文。

- [ ] **Step 8: 路由守卫(未登录跳登录页)**

在 `src/renderer/src/router/index.tsx` 的根布局或路由处,加入基于 `useUserStore.isAuthed` 的重定向:未登录且目标非 `/login` 时 `<Navigate to="/login" />`。(按脚手架现有 router 结构插入,保持懒加载方式不变。)

- [ ] **Step 9: 构建验证 + 提交**

Run: `npm run typecheck`
Expected: 通过

```bash
git add -A && git commit -m "feat: 用户态 store 与登录页(JWT 安全存储)"
```

---

### Task 4: 项目记忆服务层(检索 + 写入 + 列表/删除)

**Files:**
- Modify: `src/renderer/src/services/server.ts`
- Create: `src/renderer/src/mock/project-memory.ts`
- Test: `src/renderer/src/services/__tests__/project-memory.test.ts`

**Interfaces:**
- Consumes: `request`, `ServerApiUrls` (Task 2)
- Produces(group_id 由服务端从 JWT 推导,客户端不传):
  - `ProjectMemory = {id,groupId,content,tags:string[],sourceUser,createdAt,updatedAt}`
  - `searchProjectMemory(query,topK?): Promise<ProjectMemory[]>`
  - `writeProjectMemory(content,tags?): Promise<ProjectMemory>`
  - `listProjectMemory(limit?,offset?): Promise<ProjectMemory[]>`
  - `deleteProjectMemory(id): Promise<{deleted:boolean}>`

- [ ] **Step 1: 写失败测试 services/__tests__/project-memory.test.ts**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { searchProjectMemory, writeProjectMemory } from '../server'
import { request } from '@/request'

vi.mock('@/request', () => ({ request: { post: vi.fn(), get: vi.fn(), delete: vi.fn() } }))

describe('project memory service', () => {
  beforeEach(() => vi.clearAllMocks())
  it('search posts query without group_id', async () => {
    ;(request.post as any).mockResolvedValue([])
    await searchProjectMemory('部署', 3)
    expect(request.post).toHaveBeenCalledWith('/api/project-memory/search', { query: '部署', topK: 3 })
  })
  it('write posts content and tags', async () => {
    ;(request.post as any).mockResolvedValue({ id: 'm1' })
    await writeProjectMemory('内容', ['t'])
    expect(request.post).toHaveBeenCalledWith('/api/project-memory', { content: '内容', tags: ['t'] })
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test src/renderer/src/services/__tests__/project-memory.test.ts`
Expected: FAIL

- [ ] **Step 3: 在 services/server.ts 追加项目记忆函数**

```ts
export interface ProjectMemory {
  id: string
  groupId: string
  content: string
  tags: string[]
  sourceUser: string
  createdAt: number
  updatedAt: number
}

export function searchProjectMemory(query: string, topK = 5): Promise<ProjectMemory[]> {
  return request.post<ProjectMemory[]>(ServerApiUrls.projectMemorySearch, { query, topK })
}

export function writeProjectMemory(content: string, tags: string[] = []): Promise<ProjectMemory> {
  return request.post<ProjectMemory>(ServerApiUrls.projectMemory, { content, tags })
}

export function listProjectMemory(limit = 50, offset = 0): Promise<ProjectMemory[]> {
  return request.get<ProjectMemory[]>(ServerApiUrls.projectMemory, { params: { limit, offset } })
}

export function deleteProjectMemory(id: string): Promise<{ deleted: boolean }> {
  return request.delete<{ deleted: boolean }>(`${ServerApiUrls.projectMemory}/${id}`)
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test src/renderer/src/services/__tests__/project-memory.test.ts`
Expected: PASS

- [ ] **Step 5: 写 mock/project-memory.ts**

```ts
import { registerMock } from '@/mock'
import { ServerApiUrls } from '@/request/urls'

const now = 1_700_000_000_000
registerMock('GET', ServerApiUrls.projectMemory, () => [
  { id: 'm1', groupId: 'g1', content: '部署用内部 k8s 集群', tags: ['部署'], sourceUser: 'u1', createdAt: now, updatedAt: now }
])
registerMock('POST', ServerApiUrls.projectMemorySearch, () => [])
registerMock('POST', ServerApiUrls.projectMemory, (p: any) => ({ id: 'm2', groupId: 'g1', content: p.content, tags: p.tags ?? [], sourceUser: 'u1', createdAt: now, updatedAt: now }))
```

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "feat: 项目记忆服务层(检索/写入/列表/删除)"
```

---

### Task 5: 个人记忆服务层(本地 echo-agent memory API)

**Files:**
- Modify: `src/renderer/src/request/urls.ts`(确认 `AgentApiUrls` 含 memory 路径,缺则补)
- Create: `src/renderer/src/utils/agent.ts` + 在 `utils/index.ts` 导出
- Create: `src/renderer/src/services/agent-memory.ts`
- Test: `src/renderer/src/services/__tests__/agent-memory.test.ts`

**Interfaces:**
- Consumes: `agent.httpProxy` 与 `agent.getPort`(脚手架 BridgeApi 已有)
- Produces:
  - `agentHttp<T>(path, init?): Promise<T>`(拼本地端口 + 经 httpProxy 调用 + 解析 JSON)
  - `PersonalMemory = {id,type,tier,key,content,tags:string[],importance:number}`
  - `listPersonalMemory()/searchPersonalMemory(query)/deletePersonalMemory(id)`

> 说明:本地 echo-agent Gateway 在 `127.0.0.1:<动态端口>`,渲染层走主进程 `agent.httpProxy`(脚手架已提供)。先在 utils 暴露 `agentHttp` 门面,符合 PAGE_GUIDE「不直接用 window.api」。

- [ ] **Step 1: 在 utils 暴露 agentHttp 门面**

新建 `src/renderer/src/utils/agent.ts`:
```ts
export async function agentHttp<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const port = await window.api.agent.getPort()
  if (!port) throw new Error('本地 Agent 未运行')
  const res = await window.api.agent.httpProxy({
    url: `http://127.0.0.1:${port}${path}`,
    method: init?.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    body: init?.body ? JSON.stringify(init.body) : undefined
  })
  return JSON.parse(res.body) as T
}
```
在 `src/renderer/src/utils/index.ts` 追加:`export { agentHttp } from './agent'`。

- [ ] **Step 2: 确认 echo-agent memory 路径**

打开 `src/renderer/src/request/urls.ts` 的 `AgentApiUrls`,确保包含(缺则补):
```ts
memoryList: '/api/v1/memory',
memorySearch: '/api/v1/memory/search',
memoryDelete: '/api/v1/memory'
```

- [ ] **Step 3: 写失败测试 services/__tests__/agent-memory.test.ts**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { listPersonalMemory } from '../agent-memory'
import { agentHttp } from '@/utils/agent'

vi.mock('@/utils/agent', () => ({ agentHttp: vi.fn() }))

describe('agent memory service', () => {
  beforeEach(() => vi.clearAllMocks())
  it('lists personal memory from local agent', async () => {
    ;(agentHttp as any).mockResolvedValue([{ id: 'p1', type: 'user', tier: 'semantic', key: 'k', content: 'c', tags: [], importance: 0.5 }])
    const res = await listPersonalMemory()
    expect(agentHttp).toHaveBeenCalledWith('/api/v1/memory')
    expect(res[0].id).toBe('p1')
  })
})
```

- [ ] **Step 4: 运行确认失败**

Run: `npm test src/renderer/src/services/__tests__/agent-memory.test.ts`
Expected: FAIL

- [ ] **Step 5: 实现 services/agent-memory.ts**

```ts
import { agentHttp } from '@/utils/agent'
import { AgentApiUrls } from '@/request/urls'

export interface PersonalMemory {
  id: string
  type: string
  tier: string
  key: string
  content: string
  tags: string[]
  importance: number
}

export function listPersonalMemory(): Promise<PersonalMemory[]> {
  return agentHttp<PersonalMemory[]>(AgentApiUrls.memoryList)
}

export function searchPersonalMemory(query: string): Promise<PersonalMemory[]> {
  return agentHttp<PersonalMemory[]>(AgentApiUrls.memorySearch, { method: 'POST', body: { query } })
}

export function deletePersonalMemory(id: string): Promise<void> {
  return agentHttp<void>(`${AgentApiUrls.memoryDelete}/${id}`, { method: 'DELETE' })
}
```

- [ ] **Step 6: 运行确认通过**

Run: `npm test src/renderer/src/services/__tests__/agent-memory.test.ts`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add -A && git commit -m "feat: 个人记忆服务层(本地 echo-agent memory API)"
```

---

### Task 6: 记忆分流确认编排(D 方案纯逻辑)

**Files:**
- Create: `src/renderer/src/services/memory-router.ts`
- Test: `src/renderer/src/services/__tests__/memory-router.test.ts`

**Interfaces:**
- Consumes: `writeProjectMemory` (Task 4)
- Produces:
  - `MemoryCandidate = {content:string; tags:string[]; reason?:string}`
  - `ShareDecision = 'share'|'local'|'discard'`
  - `confirmShareToProject(candidate, decision): Promise<{shared:boolean}>`

> 说明:候选识别来自本地 echo-agent 对 `ENVIRONMENT` 类型记忆的判定。本 Task 只实现"候选 → 按决定路由"的纯逻辑,UI 确认框在 Task 7 接入,便于独立测试。

- [ ] **Step 1: 写失败测试 services/__tests__/memory-router.test.ts**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { confirmShareToProject } from '../memory-router'
import * as server from '../server'

vi.spyOn(server, 'writeProjectMemory').mockResolvedValue({ id: 'm1' } as any)

describe('memory router (D)', () => {
  beforeEach(() => vi.clearAllMocks())
  it('share writes to project memory', async () => {
    const r = await confirmShareToProject({ content: '规范', tags: [] }, 'share')
    expect(server.writeProjectMemory).toHaveBeenCalledWith('规范', [])
    expect(r.shared).toBe(true)
  })
  it('local/discard does not call server', async () => {
    expect((await confirmShareToProject({ content: 'x', tags: [] }, 'local')).shared).toBe(false)
    expect((await confirmShareToProject({ content: 'x', tags: [] }, 'discard')).shared).toBe(false)
    expect(server.writeProjectMemory).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test src/renderer/src/services/__tests__/memory-router.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 services/memory-router.ts**

```ts
import { writeProjectMemory } from './server'

export interface MemoryCandidate {
  content: string
  tags: string[]
  reason?: string
}

export type ShareDecision = 'share' | 'local' | 'discard'

export async function confirmShareToProject(
  candidate: MemoryCandidate,
  decision: ShareDecision
): Promise<{ shared: boolean }> {
  if (decision === 'share') {
    await writeProjectMemory(candidate.content, candidate.tags)
    return { shared: true }
  }
  return { shared: false }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test src/renderer/src/services/__tests__/memory-router.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: 记忆分流确认编排(D 方案纯逻辑)"
```

---

### Task 7: 聊天页接入(本地推理 + 项目记忆注入 + 分流确认)

**Files:**
- Modify: `src/renderer/src/pages/Chat/index.tsx`
- Modify: `src/renderer/src/stores/chatStore.ts`
- Create: `src/renderer/src/components/ShareMemoryDialog/index.tsx`
- Test: `src/renderer/src/stores/__tests__/chatStore.test.ts`

**Interfaces:**
- Consumes: `agentHttp` (T5)、`searchProjectMemory` (T4)、`confirmShareToProject` (T6)
- Produces:
  - `ChatMessage = {id,role:'user'|'assistant',content}`
  - `chatStore.sendMessage(text): Promise<void>`(检索项目记忆 → 注入本地 echo-agent 请求 → 回复入列表)
  - `ShareMemoryDialog`(候选展示 + 三按钮)

> 说明:发消息走本地 echo-agent `AgentApiUrls.message`。项目记忆放入请求的 `context` 数组。流式输出为 P1,本 Task 先非流式整段返回打通链路。echo-agent message 响应字段名(`reply`)以实际为准,联调校正。

- [ ] **Step 1: 写失败测试 stores/__tests__/chatStore.test.ts**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const search = vi.fn(async () => [{ id: 'm1', content: '部署规范X', groupId: 'g1', tags: [], sourceUser: 'u', createdAt: 0, updatedAt: 0 }])
const agentHttp = vi.fn(async () => ({ reply: '好的' }))
vi.mock('@/services/server', () => ({ searchProjectMemory: search }))
vi.mock('@/utils/agent', () => ({ agentHttp }))

import { useChatStore } from '../chatStore'

describe('chatStore.sendMessage', () => {
  beforeEach(() => { vi.clearAllMocks(); useChatStore.setState({ messages: [] }) })
  it('injects project memory into the agent request', async () => {
    await useChatStore.getState().sendMessage('如何部署')
    expect(search).toHaveBeenCalledWith('如何部署')
    const call = agentHttp.mock.calls[0]
    expect(JSON.stringify(call)).toContain('部署规范X')
    expect(useChatStore.getState().messages.some((m: any) => m.role === 'assistant')).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test src/renderer/src/stores/__tests__/chatStore.test.ts`
Expected: FAIL

- [ ] **Step 3: 在 chatStore.ts 实现 sendMessage**

```ts
import { create } from 'zustand'
import { agentHttp } from '@/utils/agent'
import { AgentApiUrls } from '@/request/urls'
import { searchProjectMemory } from '@/services/server'

export interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string }

interface ChatState {
  messages: ChatMessage[]
  sendMessage: (text: string) => Promise<void>
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  async sendMessage(text) {
    const userMsg: ChatMessage = { id: `u-${get().messages.length}`, role: 'user', content: text }
    set({ messages: [...get().messages, userMsg] })
    let context: string[] = []
    try {
      const mems = await searchProjectMemory(text)
      context = mems.map((m) => m.content)
    } catch {
      // 服务器不可达时降级:无项目记忆注入
    }
    const resp = await agentHttp<{ reply: string }>(AgentApiUrls.message, {
      method: 'POST',
      body: { message: text, context }
    })
    const aiMsg: ChatMessage = { id: `a-${get().messages.length}`, role: 'assistant', content: resp.reply }
    set({ messages: [...get().messages, aiMsg] })
  }
}))
```
> 若脚手架 `chatStore.ts` 已有内容,合并而非覆盖既有字段。

- [ ] **Step 4: 运行确认通过**

Run: `npm test src/renderer/src/stores/__tests__/chatStore.test.ts`
Expected: PASS

- [ ] **Step 5: 实现 ShareMemoryDialog 组件**

```tsx
import { useTranslation } from 'react-i18next'
import type { MemoryCandidate, ShareDecision } from '@/services/memory-router'

interface Props {
  candidate: MemoryCandidate | null
  onDecide: (decision: ShareDecision) => void
}

export default function ShareMemoryDialog({ candidate, onDecide }: Props): JSX.Element | null {
  const { t } = useTranslation()
  if (!candidate) return null
  return (
    <div role="dialog" aria-label={t('memory.shareTitle')}>
      <p>{t('memory.sharePrompt')}</p>
      <blockquote>{candidate.content}</blockquote>
      <button onClick={() => onDecide('share')}>{t('memory.share')}</button>
      <button onClick={() => onDecide('local')}>{t('memory.localOnly')}</button>
      <button onClick={() => onDecide('discard')}>{t('memory.discard')}</button>
    </div>
  )
}
```
i18n(中英各一份):`"memory": {"shareTitle":"共享到项目记忆?","sharePrompt":"以下内容可能与项目相关,是否共享给同组成员?","share":"共享到组","localOnly":"仅存本地","discard":"丢弃"}`

- [ ] **Step 6: 在 Chat 页接线**

`pages/Chat/index.tsx`:输入框调 `useChatStore().sendMessage`;消息列表用 `react-virtuoso`;当本地 echo-agent 返回候选项目记忆时设 `candidate` 弹 `ShareMemoryDialog`,用户选择后调 `confirmShareToProject(candidate, decision)` 并 toast 结果。按 Chat 页既有结构补充,不重写无关部分。

- [ ] **Step 7: 构建验证 + 提交**

Run: `npm run typecheck`
Expected: 通过

```bash
git add -A && git commit -m "feat: 聊天页接入本地推理、项目记忆注入与分流确认"
```

---

### Task 8: 记忆区视图(个人 + 项目两个 Tab)

**Files:**
- Create: `src/renderer/src/pages/Memory/index.tsx` + `memory.module.scss`
- Modify: `constants/index.ts`、`router/index.tsx`(`new:page` 自动注册)

**Interfaces:**
- Consumes: `listPersonalMemory` (T5)、`listProjectMemory` (T4)、`ahooks` 的 `useRequest`

- [ ] **Step 1: 生成页面骨架**

```bash
npm run new:page
# 输入 Memory
```

- [ ] **Step 2: 实现 pages/Memory/index.tsx**

```tsx
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useRequest } from 'ahooks'
import { listPersonalMemory } from '@/services/agent-memory'
import { listProjectMemory } from '@/services/server'
import styles from './memory.module.scss'

type Tab = 'personal' | 'project'

export default function Memory(): JSX.Element {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('personal')
  const personal = useRequest(listPersonalMemory, { ready: tab === 'personal', refreshDeps: [tab] })
  const project = useRequest(listProjectMemory, { ready: tab === 'project', refreshDeps: [tab] })
  const list = tab === 'personal' ? personal.data ?? [] : project.data ?? []

  return (
    <div className={styles.wrap}>
      <div className={styles.tabs}>
        <button data-active={tab === 'personal'} onClick={() => setTab('personal')}>{t('memory.personal')}</button>
        <button data-active={tab === 'project'} onClick={() => setTab('project')}>{t('memory.project')}</button>
      </div>
      <ul>
        {list.map((m: any) => (
          <li key={m.id}>{m.content}</li>
        ))}
      </ul>
    </div>
  )
}
```
i18n 增加 `"memory.personal":"个人记忆"`、`"memory.project":"项目记忆"`(中英)。

- [ ] **Step 3: 构建验证**

Run: `npm run typecheck`
Expected: 通过

- [ ] **Step 4: 提交**

```bash
git add -A && git commit -m "feat: 记忆区视图(个人/项目双 Tab)"
```

---

### Task 9: 设置页模型配置(A 下发 + B 本地覆盖)

**Files:**
- Modify: `src/renderer/src/pages/Settings/index.tsx`
- Create: `src/renderer/src/services/model-config.ts`
- Modify: `src/main/agent-process/config-gen.ts`(确认 apiBase 写入)
- Test: `src/renderer/src/services/__tests__/model-config.test.ts`

**Interfaces:**
- Consumes: `fetchModelConfig` (T2)、`agent.updateConfig`/`agent.start` 门面(脚手架已有)
- Produces:
  - `LocalModelConfig = {baseUrl,modelName}`
  - `resolveEffectiveModelConfig(server:ModelConfigDTO, local:LocalModelConfig|null): {baseUrl,modelName,source:'server'|'local'}`

- [ ] **Step 1: 写失败测试 services/__tests__/model-config.test.ts**

```ts
import { describe, it, expect } from 'vitest'
import { resolveEffectiveModelConfig } from '../model-config'

describe('resolveEffectiveModelConfig', () => {
  const server = { baseUrl: 'https://srv', modelName: 'srv-model', allowLocalOverride: false, hasCredential: true }
  it('uses server when override disallowed', () => {
    const r = resolveEffectiveModelConfig(server, { baseUrl: 'https://local', modelName: 'local-model' })
    expect(r.source).toBe('server')
    expect(r.baseUrl).toBe('https://srv')
  })
  it('uses local when override allowed and local present', () => {
    const r = resolveEffectiveModelConfig({ ...server, allowLocalOverride: true }, { baseUrl: 'https://local', modelName: 'local-model' })
    expect(r.source).toBe('local')
    expect(r.baseUrl).toBe('https://local')
  })
  it('falls back to server when override allowed but no local', () => {
    const r = resolveEffectiveModelConfig({ ...server, allowLocalOverride: true }, null)
    expect(r.source).toBe('server')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test src/renderer/src/services/__tests__/model-config.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 services/model-config.ts**

```ts
import type { ModelConfigDTO } from './server'

export interface LocalModelConfig { baseUrl: string; modelName: string }
export interface EffectiveModelConfig { baseUrl: string | null; modelName: string | null; source: 'server' | 'local' }

export function resolveEffectiveModelConfig(
  server: ModelConfigDTO,
  local: LocalModelConfig | null
): EffectiveModelConfig {
  if (server.allowLocalOverride && local) {
    return { baseUrl: local.baseUrl, modelName: local.modelName, source: 'local' }
  }
  return { baseUrl: server.baseUrl, modelName: server.modelName, source: 'server' }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test src/renderer/src/services/__tests__/model-config.test.ts`
Expected: PASS

- [ ] **Step 5: 设置页接线 + config-gen 确认**

- `pages/Settings/index.tsx`:加载调 `fetchModelConfig`;按 `allowLocalOverride` 决定本地表单是否只读;保存时用 `resolveEffectiveModelConfig` 得生效配置,调 `agent.updateConfig({ defaultModel: effective.modelName, providers:[{ name, apiBase: effective.baseUrl }] })`。
- `config-gen.ts`:脚手架已写 `apiBase`,确认即可;Key/凭证经 `agent.start(apiKeys)` 的 env 注入,不写 yaml。

- [ ] **Step 6: 构建验证 + 提交**

Run: `npm run typecheck`
Expected: 通过

```bash
git add -A && git commit -m "feat: 设置页模型配置(服务端下发 + 本地覆盖策略)"
```

---

### Task 10: 管理页(用户/组管理,仅管理员)

**Files:**
- Modify: `src/renderer/src/services/server.ts`(管理 API)
- Modify: `src/renderer/src/request/index.ts`(若 `request` 门面缺 `patch` 则补)
- Create: `src/renderer/src/pages/Admin/index.tsx` + `admin.module.scss`
- Modify: 主导航/布局(按角色条件渲染入口)
- Test: `src/renderer/src/services/__tests__/admin.test.ts`

**Interfaces:**
- Consumes: `request`, `ServerApiUrls` (T2), `useUserStore`(读 role)
- Produces:
  - `ServerGroup = {id,name,createdAt}`
  - `adminListUsers()/adminCreateUser(input)/adminUpdateUser(id,patch)/adminListGroups()/adminCreateGroup(name)`

- [ ] **Step 1: 写失败测试 services/__tests__/admin.test.ts**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { adminCreateGroup, adminCreateUser } from '../server'
import { request } from '@/request'

vi.mock('@/request', () => ({ request: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }))

describe('admin services', () => {
  beforeEach(() => vi.clearAllMocks())
  it('creates a group', async () => {
    ;(request.post as any).mockResolvedValue({ id: 'g1', name: '研发' })
    await adminCreateGroup('研发')
    expect(request.post).toHaveBeenCalledWith('/api/admin/groups', { name: '研发' })
  })
  it('creates a user with group', async () => {
    ;(request.post as any).mockResolvedValue({ id: 'u1' })
    await adminCreateUser({ username: 'm', password: 'pw', role: 'member', groupId: 'g1' })
    expect(request.post).toHaveBeenCalledWith('/api/admin/users', { username: 'm', password: 'pw', role: 'member', groupId: 'g1' })
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test src/renderer/src/services/__tests__/admin.test.ts`
Expected: FAIL

- [ ] **Step 3: 确认 request 门面有 patch(缺则补)**

打开 `src/renderer/src/request/index.ts`,若 `request` 对象无 `patch`,在 `delete` 旁加:
```ts
patch<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
  return instance.patch(url, data, config)
},
```

- [ ] **Step 4: 在 services/server.ts 追加管理 API**

```ts
export interface ServerGroup { id: string; name: string; createdAt: number }

export function adminListUsers(): Promise<ServerUser[]> {
  return request.get<ServerUser[]>(ServerApiUrls.adminUsers)
}
export function adminCreateUser(input: { username: string; password: string; role: 'member' | 'admin'; groupId: string | null }): Promise<ServerUser> {
  return request.post<ServerUser>(ServerApiUrls.adminUsers, input)
}
export function adminUpdateUser(id: string, patch: { groupId?: string; disabled?: boolean }): Promise<{ updated: boolean }> {
  return request.patch<{ updated: boolean }>(`${ServerApiUrls.adminUsers}/${id}`, patch)
}
export function adminListGroups(): Promise<ServerGroup[]> {
  return request.get<ServerGroup[]>(ServerApiUrls.adminGroups)
}
export function adminCreateGroup(name: string): Promise<ServerGroup> {
  return request.post<ServerGroup>(ServerApiUrls.adminGroups, { name })
}
```

- [ ] **Step 5: 运行确认通过**

Run: `npm test src/renderer/src/services/__tests__/admin.test.ts`
Expected: PASS

- [ ] **Step 6: 实现 Admin 页 + 条件渲染入口**

- `npm run new:page` 输入 `Admin`;页面用 `useRequest` 拉 `adminListUsers/adminListGroups`,提供建组、建用户、改组/禁用表单(react-hook-form + zod)。
- 主导航/布局处:`const role = useUserStore(s => s.user?.role)`;仅 `role === 'admin'` 渲染"管理"入口与 `/admin` 路由。

- [ ] **Step 7: 构建验证 + 提交**

Run: `npm run typecheck`
Expected: 通过

```bash
git add -A && git commit -m "feat: 管理页(用户/组管理,按角色条件渲染)"
```

---

### Task 11: 端到端联调、组隔离验证与打包

**Files:**
- Create: `docs/E2E-CHECKLIST.md`
- Modify: `electron-builder.yml`(确认内置 Python 资源打包,脚手架已有 resources)

**Interfaces:**
- Consumes: 全部;需 echo-agent-server 已运行(plan 1)

- [ ] **Step 1: 启动服务器**

```bash
cd "/Users/fuyuxiang/Documents/100-主业/130-东方国信/13.代码仓库/echo-agent-server"
cp .env.example .env   # 设置 ECHO_SERVER_SECRET 与初始管理员
npm run dev
```
Expected: 控制台输出 `echo-agent-server listening on :8787`

- [ ] **Step 2: 启动客户端,走 Onboarding 装本地 echo-agent**

```bash
cd "/Users/fuyuxiang/Documents/100-主业/130-东方国信/13.代码仓库/echo-agent-desktop"
npm run dev
```
手动验证:Onboarding 完成 Python 环境与 echo-agent 安装(`agent.getEnvInfo` 变 ready),Agent 状态变 running。

- [ ] **Step 3: 端到端流程手测,写入 docs/E2E-CHECKLIST.md**

```markdown
# E2E 验收清单
- [ ] 管理员登录(初始 admin),建组 g1/g2,各建一个成员
- [ ] 成员 a(g1)登录 → 聊天 → 触发项目记忆候选 → 选「共享到组」→ 写入成功
- [ ] 成员 a 在记忆区「项目记忆」Tab 看到该条
- [ ] 成员 b(g2)登录 → 记忆区项目记忆为空(组隔离生效)
- [ ] 成员 b 聊天检索同关键词 → 不返回 g1 的记忆
- [ ] 个人记忆:a 的个人偏好存本地,b 登录看不到(本地隔离)
- [ ] 模型配置:管理员设 allowLocalOverride=false → 成员设置页表单只读
- [ ] 断开服务器 → 聊天仍可用(项目记忆注入降级为空,本地推理正常)
```

- [ ] **Step 4: 打包验证**

```bash
npm run build:unpack
```
Expected: 产物目录生成;手动启动产物确认内置 echo-agent 能拉起。
> 正式 dmg/nsis 打包(`build:mac`/`build:win`)与签名按脚手架现状,产物供内部分发。

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "docs: 端到端验收清单与打包验证说明"
```

---

## Self-Review

- **Spec 覆盖(P0)**:登录/用户态(T3)、模型配置 A+B(T2,T9)、个人记忆视图(T5,T8)、项目记忆存取(T4)、项目记忆注入(T7)、记忆分流 D(T6,T7)、管理页(T10)、Onboarding/本地 echo-agent(复用脚手架 + T11 验证)、组隔离端到端(T11)。spec 第 5 节 P0 项均有对应任务;P1/P2(流式、产物面板、自进化审阅、知识库、办公技能、Quick Bar)按 spec 里程碑第 7 条后续增量,不在本计划。
- **依赖顺序**:本计划依赖 plan 1(echo-agent-server)先完成。
- **Placeholder**:无 TODO/TBD;凡"按脚手架现状确认"处均给出确认动作与默认值。
- **类型一致性**:`ServerUser` T2 定义、T3/T10 复用;`ProjectMemory` T4 定义、T7/T8 复用;`ModelConfigDTO` T2 定义、T9 复用;`agentHttp` T5 定义、T7 复用;`request.patch` 在 T10 显式补齐;`groupId` 全程命名一致。
- **基建合规**:新增能力走"utils 门面(agentHttp)"或"services/urls",未在页面直接用 window.api,符合 PAGE_GUIDE。
