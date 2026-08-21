import type {
  OrgUser,
  RetrieveResult,
  OrgDocListResult,
  PromoteRequest,
  MyPromotion,
  OrgScope
} from '@shared/types/org'

/**
 * 企业服务器 HTTP 客户端(主进程侧)。
 *
 * 放主进程而非渲染层的原因:token 存在 safeStorage 加密区,渲染层拿不到也
 * 不该拿到。渲染层只经 IPC 调用,凭证从不进入页面上下文 —— 这样即便渲染层
 * 被注入脚本,也偷不走企业凭证。
 */

export class OrgAuthError extends Error {
  constructor(message = '未登录或凭证已过期') {
    super(message)
    this.name = 'OrgAuthError'
  }
}

export class OrgUnavailableError extends Error {
  constructor(message = '服务器不可达') {
    super(message)
    this.name = 'OrgUnavailableError'
  }
}

interface Envelope<T> {
  code: number
  msg: string
  data: T
}

export interface Tokens {
  accessToken: string
  refreshToken: string
}

export interface OrgClientDeps {
  getServerUrl: () => string
  getTokens: () => Promise<Tokens | null>
  saveTokens: (t: Tokens) => Promise<void>
  clearTokens: () => Promise<void>
  /** 注入 fetch 便于测试 */
  fetchFn?: typeof fetch
  connectTimeoutMs?: number
  readTimeoutMs?: number
}

const DEFAULT_TIMEOUT = 8000

export class OrgClient {
  private refreshing: Promise<boolean> | null = null

  constructor(private deps: OrgClientDeps) {}

  private get fetch(): typeof fetch {
    return this.deps.fetchFn ?? globalThis.fetch
  }

  private url(path: string): string {
    const base = this.deps.getServerUrl().replace(/\/$/, '')
    if (!base) throw new OrgUnavailableError('未配置服务器地址')
    return `${base}${path}`
  }

  /**
   * 发请求。超时按"读"预算算,因为注入材料在用户首 token 路径上 ——
   * 服务器慢就该降级到本地缓存,而不是让对话干等。
   */
  private async raw(
    path: string,
    init: RequestInit & { skipAuth?: boolean } = {}
  ): Promise<Response> {
    const { skipAuth, ...rest } = init
    const headers = new Headers(rest.headers)
    if (!headers.has('content-type') && rest.body && !(rest.body instanceof FormData)) {
      headers.set('content-type', 'application/json')
    }
    if (!skipAuth) {
      const tokens = await this.deps.getTokens()
      if (!tokens) throw new OrgAuthError('尚未登录企业服务器')
      headers.set('authorization', `Bearer ${tokens.accessToken}`)
    }

    const ctrl = new AbortController()
    const timer = setTimeout(
      () => ctrl.abort(),
      this.deps.readTimeoutMs ?? DEFAULT_TIMEOUT
    )
    try {
      return await this.fetch(this.url(path), { ...rest, headers, signal: ctrl.signal })
    } catch (e) {
      if (e instanceof OrgAuthError || e instanceof OrgUnavailableError) throw e
      throw new OrgUnavailableError(`${(e as Error).name}: ${(e as Error).message}`)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 带一次静默刷新的请求。
   *
   * access token 只有 1 小时,不刷新会让员工每小时被迫重新登录一次。
   * 并发 401 共用同一个刷新 Promise:refresh token 是一次性的,各自去换
   * 会让第二个请求拿着已作废的 token,反而把本可救回的会话弄丢。
   */
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res = await this.raw(path, init)

    if (res.status === 401) {
      this.refreshing =
        this.refreshing ??
        this.doRefresh().finally(() => {
          this.refreshing = null
        })
      const ok = await this.refreshing
      if (!ok) {
        await this.deps.clearTokens()
        throw new OrgAuthError()
      }
      res = await this.raw(path, init)
      if (res.status === 401) {
        await this.deps.clearTokens()
        throw new OrgAuthError()
      }
    }

    if (res.status === 403) throw new OrgAuthError('无权访问')
    if (res.status >= 500) throw new OrgUnavailableError(`服务器错误 ${res.status}`)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new OrgUnavailableError(`请求失败 ${res.status}: ${text.slice(0, 200)}`)
    }

    const body = (await res.json()) as Envelope<T>
    if (body.code !== 0) throw new OrgUnavailableError(body.msg || '请求失败')
    return body.data
  }

  private async doRefresh(): Promise<boolean> {
    const tokens = await this.deps.getTokens()
    if (!tokens?.refreshToken) return false
    try {
      const res = await this.raw('/api/v1/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ refreshToken: tokens.refreshToken }),
        skipAuth: true
      })
      if (!res.ok) return false
      const body = (await res.json()) as Envelope<Tokens>
      if (body.code !== 0) return false
      await this.deps.saveTokens(body.data)
      return true
    } catch {
      return false
    }
  }

  /** 给 OrgManager 主动获取一次当前 token(写插件凭证用)。 */
  async getTokens(): Promise<Tokens | null> {
    return this.deps.getTokens()
  }

  // ── 认证 ────────────────────────────────────────────────────────────────
  async login(username: string, password: string, deviceId: string): Promise<OrgUser> {
    const res = await this.raw('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password, deviceId }),
      skipAuth: true
    })
    if (res.status === 401) throw new OrgAuthError('用户名或密码错误')
    if (res.status === 429) throw new OrgAuthError('尝试过于频繁,请稍后再试')
    if (!res.ok) throw new OrgUnavailableError(`登录失败 ${res.status}`)

    const body = (await res.json()) as Envelope<{
      accessToken: string
      refreshToken: string
      user: OrgUser
    }>
    if (body.code !== 0) throw new OrgAuthError(body.msg)

    await this.deps.saveTokens({
      accessToken: body.data.accessToken,
      refreshToken: body.data.refreshToken
    })
    return body.data.user
  }

  async logout(): Promise<void> {
    try {
      await this.request('/api/v1/auth/logout', { method: 'POST' })
    } catch {
      // 服务端不可达也要能本地登出,否则用户被困住
    }
    await this.deps.clearTokens()
  }

  me(): Promise<OrgUser> {
    return this.request('/api/v1/me')
  }

  health(): Promise<{ ok: boolean }> {
    return this.raw('/api/v1/health', { method: 'GET', skipAuth: true })
      .then(async (res) => {
        if (!res.ok) throw new OrgUnavailableError(`服务器错误 ${res.status}`)
        const body = await res.json() as { ok?: boolean }
        return { ok: body.ok === true }
      })
  }

  // ── 检索 ────────────────────────────────────────────────────────────────
  /**
   * snake_case 字段:与方案 §4.2 服务端契约一致。
   * 服务端 schema 同时接受 camelCase 兼容旧调用,这里统一走 snake_case。
   */
  retrieve(body: {
    query: string
    limit?: number
    multi_hop?: boolean
    /** 手动限定 scope 子集:undefined = 全部可见,'org' 仅组织,'team' 仅团队,'local' 仅本地。 */
    scopes?: Array<'org' | 'team'>
  }): Promise<RetrieveResult> {
    return this.request('/api/v1/retrieve', { method: 'POST', body: JSON.stringify(body) })
  }

  // ── 文档 ────────────────────────────────────────────────────────────────
  listDocs(params: {
    scope_id?: string
    q?: string
    page?: number
    size?: number
  }): Promise<OrgDocListResult> {
    const qs = new URLSearchParams()
    if (params.scope_id) qs.set('scopeId', params.scope_id)
    if (params.q) qs.set('q', params.q)
    qs.set('page', String(params.page ?? 1))
    qs.set('size', String(params.size ?? 20))
    return this.request(`/api/v1/docs?${qs.toString()}`)
  }

  scopes(): Promise<OrgScope[]> {
    return this.request('/api/v1/scopes')
  }

  // ── 知识提升 ────────────────────────────────────────────────────────────
  promote(req: PromoteRequest): Promise<{ promotionId: string }> {
    return this.request('/api/v1/promotions', { method: 'POST', body: JSON.stringify(req) })
  }

  myPromotions(): Promise<MyPromotion[]> {
    return this.request('/api/v1/promotions/mine')
  }

  // ── 质量回传 ────────────────────────────────────────────────────────────
  qaEvent(body: {
    question: string
    answered: boolean
    cited_chunks?: string[]
    top_score?: number
    latency_ms?: number
    route?: 'fast' | 'agentic'
  }): Promise<{ id: string }> {
    return this.request('/api/v1/qa-events', {
      method: 'POST',
      body: JSON.stringify({
        question: body.question,
        answered: body.answered,
        citedChunks: body.cited_chunks,
        topScore: body.top_score,
        latencyMs: body.latency_ms,
        route: body.route
      })
    })
  }

  // ── 同步 ────────────────────────────────────────────────────────────────
  sync(cursor: number, deviceId: string): Promise<{
    nextCursor: number
    docs: {
      docId: string
      title: string
      scopeKind: string
      updatedAt: number
      chunks: {
        chunkId: string
        text: string
        heading: string | null
        locPage: number | null
        locStartMs: number | null
        modality: string
      }[]
    }[]
    memories: { id: string; kind: string; content: string; scopeKind: string }[]
    revokedDocs: string[]
    revokedMemories: string[]
    purgeAll: boolean
    hasMore: boolean
  }> {
    const qs = new URLSearchParams({ cursor: String(cursor), deviceId })
    return this.request(`/api/v1/sync?${qs.toString()}`)
  }
}
