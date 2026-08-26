import { randomUUID } from 'node:crypto'
import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  OrgStatus,
  OrgUser,
  RetrieveResult,
  PromoteRequest,
  PromoteResult,
  MyPromotion,
  SyncResult,
  OrgScope
} from '@shared/types/org'
import { OrgClient, OrgAuthError, OrgUnavailableError } from './client'
import type { OrgCache } from './cache'

/**
 * 凭证文件路径。echo-agent-org 插件按 mtime 变化重载,桌面只要写一次
 * 文件,Python agent 下次启动即会读到新 token。退出/换账号时清空文件。
 */
function pluginCredentialsPath(): string {
  const home = process.env.ECHO_AGENT_HOME ?? join(process.env.HOME ?? '~', '.echo-agent')
  return join(home, 'plugins', 'org', 'credentials.json')
}

async function writeCredentialsFile(payload: {
  accessToken: string
  userId: string
}): Promise<void> {
  const path = pluginCredentialsPath()
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify({
    access_token: payload.accessToken,
    user_id: payload.userId
  }, null, 2))
  // best-effort chmod,Windows 上无效
  try {
    await chmod(path, 0o600)
  } catch {
    /* ignore */
  }
}

async function clearCredentialsFile(): Promise<void> {
  try {
    await unlink(pluginCredentialsPath())
  } catch {
    /* ignore */
  }
}

/**
 * 组织知识服务。降级策略全部集中在这里,页面与 agent 都不必各自处理。
 *
 * 两条不能违背的规则:
 *   1. 服务器不可达 → 读本地缓存(出差、内网隔离时仍能答常见问题);
 *   2. 凭证失效 → 不读缓存。缓存里是服务端刚刚收回权限的内容,继续提供
 *      等于让权限撤销失效。这一条比"体验好"重要。
 */

export interface OrgManagerDeps {
  client: OrgClient
  cache: OrgCache
  getServerUrl: () => string
  hasTokens: () => Promise<boolean>
  deviceId: string
  log?: { info(m: string): void; warn(m: string): void }
}

export class OrgManager {
  private user: OrgUser | null = null
  private reachable: boolean | null = null
  private syncing = false

  constructor(private deps: OrgManagerDeps) {}

  async status(): Promise<OrgStatus> {
    const serverUrl = this.deps.getServerUrl()
    const loggedIn = await this.deps.hasTokens()
    const stats = this.deps.cache.stats()
    return {
      configured: !!serverUrl,
      serverUrl,
      loggedIn,
      user: this.user,
      reachable: this.reachable,
      lastSyncAt: stats.lastSyncAt,
      cachedDocs: stats.docs,
      cachedChunks: stats.chunks
    }
  }

  async login(username: string, password: string): Promise<{ ok: boolean; user?: OrgUser; error?: string }> {
    try {
      this.user = await this.deps.client.login(username, password, this.deps.deviceId)
      this.reachable = true
      // 写一份凭证到 echo-agent-org 插件期望的文件位置,插件按 mtime
      // 重载,Python agent 下次启动即会读到企业 token。
      const tokens = await this.deps.client.getTokens()
      if (tokens) {
        await this.syncPluginCredentials(tokens, this.user.id)
      }
      // 登录后立刻拉一次,让离线兜底从第一分钟就有内容。失败不影响登录成功。
      void this.sync().catch(() => {})
      return { ok: true, user: this.user }
    } catch (e) {
      this.reachable = e instanceof OrgUnavailableError ? false : this.reachable
      return { ok: false, error: (e as Error).message }
    }
  }

  async logout(): Promise<void> {
    try {
      await this.deps.client.logout()
    } catch {
      // 服务端不可达也要能本地登出,否则用户被困住
    }
    await this.clearLocalSession()
  }

  /** safeStorage token 刷新后同步插件凭证,避免插件一小时后继续使用旧 access token。 */
  async syncPluginCredentials(
    tokens: { accessToken: string; refreshToken: string },
    userId = this.user?.id ?? ''
  ): Promise<void> {
    await writeCredentialsFile({ accessToken: tokens.accessToken, userId })
  }

  /** 换服务器、登出或鉴权失效时统一清理本地企业身份和缓存。 */
  async clearLocalSession(): Promise<void> {
    this.user = null
    await clearCredentialsFile()
    this.deps.cache.clearAll()
  }

  /** 启动时恢复会话。失败静默 —— 未登录是正常状态,不该弹错误。 */
  async restore(): Promise<OrgUser | null> {
    if (!this.deps.getServerUrl()) return null
    if (!(await this.deps.hasTokens())) return null
    try {
      this.user = await this.deps.client.me()
      this.reachable = true
      const tokens = await this.deps.client.getTokens()
      if (tokens) await this.syncPluginCredentials(tokens, this.user.id)
      return this.user
    } catch (e) {
      if (e instanceof OrgUnavailableError) this.reachable = false
      return null
    }
  }

  async scopes(): Promise<OrgScope[]> {
    try {
      return await this.deps.client.scopes()
    } catch {
      return []
    }
  }

  modelConfig(): ReturnType<OrgClient['modelConfig']> {
    return this.deps.client.modelConfig()
  }

  openAiChat(body: string, signal?: AbortSignal): Promise<Response> {
    return this.deps.client.openAiChat(body, signal)
  }

  listMemories(params: Parameters<OrgClient['listMemories']>[0] = {}): ReturnType<OrgClient['listMemories']> {
    return this.deps.client.listMemories(params)
  }

  adminListUsers(): ReturnType<OrgClient['adminListUsers']> {
    return this.deps.client.adminListUsers()
  }

  adminCreateUser(input: Parameters<OrgClient['adminCreateUser']>[0]): ReturnType<OrgClient['adminCreateUser']> {
    return this.deps.client.adminCreateUser(input)
  }

  adminUpdateUser(id: string, patch: Parameters<OrgClient['adminUpdateUser']>[1]): ReturnType<OrgClient['adminUpdateUser']> {
    return this.deps.client.adminUpdateUser(id, patch)
  }

  adminListGroups(): ReturnType<OrgClient['adminListGroups']> {
    return this.deps.client.adminListGroups()
  }

  adminCreateGroup(name: string): ReturnType<OrgClient['adminCreateGroup']> {
    return this.deps.client.adminCreateGroup(name)
  }

  /**
   * 检索。在线优先,失败降级到缓存。
   *
   * 返回结果里的 fromCache 让 UI 能明确告知"这是缓存内容,可能不是最新" ——
   * 静默降级会让员工把过期信息当现行制度用。
   *
   * scope 过滤:
   *   - undefined → 服务端按 JWT 实时可见 scope 全集;
   *   - ['org']   → 仅查组织层;
   *   - ['team']  → 仅查用户可见的团队层;
   *   - ['org','team'] → 同 undefined,显式表达。
   * 'local' 不传:它指 L1 个人记忆,由桌面端另一条路径返回,不混入此处。
   */
  async retrieve(
    query: string,
    opts: {
      limit?: number
      multi_hop?: boolean
      scopes?: Array<'org' | 'team'>
    } = {}
  ): Promise<RetrieveResult> {
    const wantScopes = this.scopesFromAskScope(opts.scopes)
    try {
      const res = await this.deps.client.retrieve({
        query,
        limit: opts.limit ?? 8,
        multi_hop: opts.multi_hop,
        ...(wantScopes ? { scopes: wantScopes } : {})
      })
      this.reachable = true
      return res
    } catch (e) {
      if (e instanceof OrgAuthError) {
        // 刻意不读缓存,见类注释规则 2。
        this.deps.log?.warn(`组织检索:凭证失效,跳过缓存 (${e.message})`)
        throw e
      }
      this.reachable = false
      this.deps.log?.info(`组织检索降级到本地缓存: ${(e as Error).message}`)
      return this.deps.cache.search(query, opts.limit ?? 8, wantScopes)
    }
  }

  /**
   * 把前端的 askScope 翻译成请求参数。
   *
   * - 'all' / undefined → 不传 scopes,服务端按实时可见全集;
   * - 'org' → ['org']; 'team' → ['team']; 'local' → [] (本地层走另一条路径)。
   *
   * 在线和离线缓存使用同一 scope 过滤,避免断网后扩大可见范围。
   */
  private scopesFromAskScope(
    scopes?: Array<'org' | 'team'>
  ): Array<'org' | 'team'> | undefined {
    if (!scopes) return undefined
    const out: Array<'org' | 'team'> = []
    for (const s of scopes) {
      if (s === 'org' || s === 'team') out.push(s)
    }
    return out.length > 0 ? out : undefined
  }

  /**
   * 提交候选知识。离线时入本地队列,联网后补提。
   *
   * 不排队的话,员工在飞机上整理的会议结论会直接丢掉 —— 那种体验之后就
   * 再没人愿意用沉淀功能了。
   */
  async promote(req: PromoteRequest): Promise<PromoteResult> {
    try {
      const res = await this.deps.client.promote(req)
      this.reachable = true
      return { ok: true, promotionId: res.promotionId }
    } catch (e) {
      if (e instanceof OrgAuthError) return { ok: false, error: e.message }
      this.reachable = false
      const id = randomUUID()
      this.deps.cache.enqueuePromotion({
        id,
        payloadType: req.payloadType,
        payload: JSON.stringify(req.payload),
        source: req.source,
        targetScope: req.targetScope
      })
      return { ok: true, queued: true }
    }
  }

  /** 补提本地队列。返回成功提交的条数。 */
  async flushPending(): Promise<number> {
    const rows = this.deps.cache.pendingPromotions()
    let done = 0
    for (const row of rows) {
      try {
        await this.deps.client.promote({
          payloadType: row.payloadType as 'memory' | 'document',
          payload: JSON.parse(row.payload),
          source: row.source as PromoteRequest['source'],
          targetScope: row.targetScope
        })
        this.deps.cache.markPromotionSubmitted(row.id)
        done++
      } catch (e) {
        this.deps.cache.markPromotionFailed(row.id, (e as Error).message)
        // 一条失败通常意味着网络仍不通,不必继续尝试剩下的
        if (e instanceof OrgUnavailableError) break
      }
    }
    if (done > 0) this.deps.log?.info(`已补提 ${done} 条离线知识`)
    return done
  }

  /** 我提交的。在线取服务端,并把本地未提交的合并进来一起展示。 */
  async myPromotions(): Promise<MyPromotion[]> {
    const local: MyPromotion[] = this.deps.cache.pendingPromotions().map((r) => ({
      id: r.id,
      payloadType: r.payloadType as 'memory' | 'document',
      payload: JSON.parse(r.payload),
      source: r.source as MyPromotion['source'],
      state: 'pending',
      reviewNote: r.lastError ? `待联网重试(${r.lastError})` : null,
      createdAt: r.createdAt,
      reviewedAt: null,
      scopeName: '',
      scopeKind: 'org',
      reviewerName: null,
      local: true
    }))
    try {
      const remote = await this.deps.client.myPromotions()
      return [...local, ...remote]
    } catch {
      return local
    }
  }

  async sync(): Promise<SyncResult> {
    if (this.syncing) return { ok: false, docs: 0, memories: 0, revoked: 0, error: '同步进行中' }
    this.syncing = true
    let docs = 0
    let memories = 0
    let revoked = 0
    try {
      // 分页拉完,单次上限由服务端控制。加迭代上限防御异常的 cursor 不前进。
      for (let i = 0; i < 50; i++) {
        const cursor = this.deps.cache.getCursor()
        const page = await this.deps.client.sync(cursor, this.deps.deviceId)
        this.deps.cache.applySync(page, page.nextCursor)
        docs += page.docs.length
        memories += page.memories.length
        revoked += page.revokedDocs.length + (page.revokedMemories?.length ?? 0)
        if (!page.hasMore) break
        if (page.nextCursor === cursor) break
      }
      this.reachable = true
      void this.flushPending().catch(() => {})
      return { ok: true, docs, memories, revoked }
    } catch (e) {
      if (e instanceof OrgAuthError) {
        return { ok: false, docs, memories, revoked, error: e.message }
      }
      this.reachable = false
      return { ok: false, docs, memories, revoked, error: (e as Error).message }
    } finally {
      this.syncing = false
    }
  }

  /** 上报问答质量。失败静默 —— 统计数据丢一条远不如打断用户严重。 */
  async reportQa(body: {
    question: string
    answered: boolean
    cited_chunks?: string[]
    top_score?: number
    latency_ms?: number
    route?: 'fast' | 'agentic'
  }): Promise<void> {
    try {
      await this.deps.client.qaEvent(body)
    } catch {
      /* ignore */
    }
  }

  listDocs(params: { scope_id?: string; q?: string; page?: number; size?: number }) {
    return this.deps.client.listDocs(params)
  }

  docContent(id: string, page?: number): ReturnType<OrgClient['docContent']> {
    return this.deps.client.docContent(id, page)
  }

  docRaw(id: string): ReturnType<OrgClient['docRaw']> {
    return this.deps.client.docRaw(id)
  }
}
