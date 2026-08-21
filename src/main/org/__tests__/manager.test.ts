import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrgCache } from '../cache'
import { OrgManager } from '../manager'
import { OrgClient, OrgAuthError, OrgUnavailableError } from '../client'

// 降级策略是这一层的全部价值,也是最难手动验证的部分:
//   · 服务器不可达 → 读缓存(出差、内网隔离时仍能答常见问题)
//   · 凭证失效 → 不读缓存(否则权限撤销失效)
// 后者反直觉,所以必须有测试钉住。

function makeCache(): OrgCache {
  return new OrgCache(new Database(':memory:'))
}

function seedCache(cache: OrgCache): void {
  cache.applySync(
    {
      docs: [
        {
          docId: 'd1',
          title: '差旅管理办法',
          scopeKind: 'org',
          updatedAt: Date.now(),
          chunks: [
            {
              chunkId: 'c1',
              text: '一线城市住宿标准 500 元每晚。',
              heading: '住宿标准',
              locPage: 7,
              locStartMs: null,
              modality: 'text'
            }
          ]
        }
      ],
      memories: [],
      revokedDocs: [],
      revokedMemories: [],
      purgeAll: false
    },
    1000
  )
}

interface StubClientOpts {
  retrieve?: () => Promise<unknown>
  promote?: () => Promise<{ promotionId: string }>
}

function stubClient(opts: StubClientOpts): OrgClient {
  return {
    retrieve: opts.retrieve ?? (async () => ({ chunks: [], memories: [], diagnostics: {} })),
    promote: opts.promote ?? (async () => ({ promotionId: 'p1' })),
    myPromotions: async () => [],
    logout: async () => {},
    me: async () => ({ id: 'u1' }),
    qaEvent: async () => ({ id: 'e1' })
  } as unknown as OrgClient
}

function makeManager(client: OrgClient, cache: OrgCache): OrgManager {
  return new OrgManager({
    client,
    cache,
    getServerUrl: () => 'https://echo.test',
    hasTokens: async () => true,
    deviceId: 'dev-test'
  })
}

describe('OrgManager 插件凭证', () => {
  it('写入插件读取的 snake_case 字段且不落盘 refresh token', async () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-org-creds-'))
    const previous = process.env.ECHO_AGENT_HOME
    process.env.ECHO_AGENT_HOME = root
    try {
      const manager = makeManager(stubClient({}), makeCache())
      await manager.syncPluginCredentials(
        { accessToken: 'access-token', refreshToken: 'refresh-token' },
        'user-1'
      )
      const body = JSON.parse(readFileSync(join(root, 'plugins', 'org', 'credentials.json'), 'utf8'))
      expect(body).toEqual({ access_token: 'access-token', user_id: 'user-1' })
    } finally {
      if (previous === undefined) delete process.env.ECHO_AGENT_HOME
      else process.env.ECHO_AGENT_HOME = previous
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('OrgManager 检索降级', () => {
  let cache: OrgCache

  beforeEach(() => {
    cache = makeCache()
    seedCache(cache)
  })

  it('在线时返回服务端结果', async () => {
    const client = stubClient({
      retrieve: async () => ({
        chunks: [{ chunkId: 'remote', text: '服务端结果' }],
        memories: [],
        diagnostics: { totalMs: 10 }
      })
    })
    const res = await makeManager(client, cache).retrieve('住宿标准')
    expect(res.chunks[0].chunkId).toBe('remote')
    expect(res.fromCache).toBeUndefined()
  })

  it('服务器不可达时降级到本地缓存', async () => {
    const client = stubClient({
      retrieve: async () => {
        throw new OrgUnavailableError('连接超时')
      }
    })
    const res = await makeManager(client, cache).retrieve('住宿标准')
    expect(res.chunks.length).toBeGreaterThan(0)
    expect(res.chunks[0].text).toContain('500')
    // fromCache 让 UI 能明确提示"可能不是最新" —— 静默降级会让员工
    // 把过期信息当现行制度用。
    expect(res.fromCache).toBe(true)
  })

  it('凭证失效时抛错且不读缓存', async () => {
    const client = stubClient({
      retrieve: async () => {
        throw new OrgAuthError('token 过期')
      }
    })
    // 缓存里有内容,但仍必须拒绝 —— 那是服务端刚收回权限的内容。
    await expect(makeManager(client, cache).retrieve('住宿标准')).rejects.toThrow(OrgAuthError)
  })

  it('缓存为空且服务器不可达时返回空结果而非抛错', async () => {
    const empty = makeCache()
    const client = stubClient({
      retrieve: async () => {
        throw new OrgUnavailableError('断网')
      }
    })
    const res = await makeManager(client, empty).retrieve('住宿标准')
    expect(res.chunks).toHaveLength(0)
    expect(res.fromCache).toBe(true)
  })

  it('降级后 status 反映服务器不可达', async () => {
    const client = stubClient({
      retrieve: async () => {
        throw new OrgUnavailableError('断网')
      }
    })
    const m = makeManager(client, cache)
    await m.retrieve('住宿标准')
    expect((await m.status()).reachable).toBe(false)
  })
})

describe('OrgManager 知识提交', () => {
  let cache: OrgCache

  beforeEach(() => {
    cache = makeCache()
  })

  it('在线直接提交', async () => {
    const promote = vi.fn(async () => ({ promotionId: 'p9' }))
    const res = await makeManager(stubClient({ promote }), cache).promote({
      payloadType: 'memory',
      payload: { kind: 'decision', content: '采购走线上流程' },
      source: 'meeting',
      targetScope: 's_org'
    })
    expect(res.ok).toBe(true)
    expect(res.promotionId).toBe('p9')
    expect(res.queued).toBeUndefined()
  })

  // 不排队的话,员工在飞机上整理的会议结论会直接丢掉 —— 那种体验之后
  // 就再没人愿意用沉淀功能了。
  it('离线时入本地队列而非丢弃', async () => {
    const client = stubClient({
      promote: async () => {
        throw new OrgUnavailableError('断网')
      }
    })
    const res = await makeManager(client, cache).promote({
      payloadType: 'memory',
      payload: { kind: 'decision', content: '飞机上整理的结论' },
      source: 'meeting',
      targetScope: 's_org'
    })
    expect(res.ok).toBe(true)
    expect(res.queued).toBe(true)
    expect(cache.pendingPromotions()).toHaveLength(1)
  })

  it('凭证失效时不入队,直接报错', async () => {
    const client = stubClient({
      promote: async () => {
        throw new OrgAuthError('未登录')
      }
    })
    const res = await makeManager(client, cache).promote({
      payloadType: 'memory',
      payload: { kind: 'fact', content: 'x' },
      source: 'qa',
      targetScope: 's_org'
    })
    expect(res.ok).toBe(false)
    // 入队会让用户以为提交成功了,而实际上重登后队列里是一条无主数据
    expect(cache.pendingPromotions()).toHaveLength(0)
  })

  it('联网后补提队列并清空', async () => {
    const failing = stubClient({
      promote: async () => {
        throw new OrgUnavailableError('断网')
      }
    })
    const m1 = makeManager(failing, cache)
    await m1.promote({
      payloadType: 'memory',
      payload: { kind: 'decision', content: '离线结论' },
      source: 'meeting',
      targetScope: 's_org'
    })
    expect(cache.pendingPromotions()).toHaveLength(1)

    const ok = stubClient({ promote: async () => ({ promotionId: 'p1' }) })
    const done = await makeManager(ok, cache).flushPending()
    expect(done).toBe(1)
    expect(cache.pendingPromotions()).toHaveLength(0)
  })

  it('补提再次失败时保留队列并记录原因', async () => {
    const failing = stubClient({
      promote: async () => {
        throw new OrgUnavailableError('仍然断网')
      }
    })
    const m = makeManager(failing, cache)
    await m.promote({
      payloadType: 'memory',
      payload: { kind: 'fact', content: '内容' },
      source: 'qa',
      targetScope: 's_org'
    })
    const done = await m.flushPending()
    expect(done).toBe(0)
    const pending = cache.pendingPromotions()
    expect(pending).toHaveLength(1)
    expect(pending[0].lastError).toContain('断网')
  })

  it('我提交的会合并本地未提交项', async () => {
    const failing = stubClient({
      promote: async () => {
        throw new OrgUnavailableError('断网')
      }
    })
    const m = makeManager(failing, cache)
    await m.promote({
      payloadType: 'memory',
      payload: { kind: 'decision', content: '待提交的内容' },
      source: 'meeting',
      targetScope: 's_org'
    })
    const list = await m.myPromotions()
    expect(list).toHaveLength(1)
    expect(list[0].local).toBe(true)
    expect(list[0].state).toBe('pending')
  })
})

describe('OrgManager 登出', () => {
  // 换人登录同一台机器时,不能让上一个人的可见范围留在本地。
  it('登出清空本地缓存', async () => {
    const cache = makeCache()
    seedCache(cache)
    expect(cache.stats().chunks).toBeGreaterThan(0)

    await makeManager(stubClient({}), cache).logout()
    expect(cache.stats().chunks).toBe(0)
  })
})
