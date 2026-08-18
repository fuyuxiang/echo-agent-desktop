import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type {
  OrgStatus,
  RetrieveResult,
  OrgScope,
  PromoteRequest,
  PromoteResult,
  MyPromotion
} from '@shared/types/org'

/** 问答检索的作用域。local 指本机文件与个人记忆,不含组织知识。 */
export type AskScope = 'all' | 'org' | 'team' | 'local'

interface OrgState {
  status: OrgStatus | null
  scopes: OrgScope[]
  askScope: AskScope
  syncing: boolean
  loggingIn: boolean

  init: () => Promise<void>
  refreshStatus: () => Promise<void>
  setServer: (url: string) => Promise<OrgStatus>
  login: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>
  logout: () => Promise<void>
  sync: () => Promise<{ ok: boolean; error?: string }>
  setAskScope: (scope: AskScope) => void
  retrieve: (query: string, opts?: { limit?: number; multiHop?: boolean }) => Promise<RetrieveResult>
  promote: (req: PromoteRequest) => Promise<PromoteResult>
  myPromotions: () => Promise<MyPromotion[]>
}

/** 组织知识不可用时(未配置/未登录),UI 要退回纯本地模式而不是报错。 */
export function isOrgReady(status: OrgStatus | null): boolean {
  return !!status?.configured && !!status.loggedIn
}

/**
 * org 桥接是否可用。
 *
 * 正常情况下 preload 一定注入了它,但升级过程中可能出现老 preload 配新
 * 渲染层的组合。少了这道判断,init() 会抛出无人接管的 rejection,把挂了
 * 企业组件的整个页面(如会议详情)拖垮。
 */
function bridgeReady(): boolean {
  return typeof window !== 'undefined' && !!window.api?.org
}

/** 缓存超过一天未更新就值得提示 —— 制度类内容一天的滞后通常可接受。 */
export function isCacheStale(status: OrgStatus | null, now = Date.now()): boolean {
  if (!status?.lastSyncAt) return false
  return now - status.lastSyncAt > 24 * 3600_000
}

export const useOrgStore = create<OrgState>()(
  immer((set, get) => ({
    status: null,
    scopes: [],
    askScope: 'all',
    syncing: false,
    loggingIn: false,

    init: async () => {
      if (!bridgeReady()) return
      const status = await window.api.org.status()
      set((s) => {
        s.status = status
      })
      // 主进程会在登录态或可达性变化时推送,避免页面各自轮询。
      window.api.org.onStatusChanged((next) => {
        set((s) => {
          s.status = next
        })
      })
      if (isOrgReady(status)) {
        const scopes = await window.api.org.scopes()
        set((s) => {
          s.scopes = scopes
        })
      }
    },

    refreshStatus: async () => {
      if (!bridgeReady()) return
      const status = await window.api.org.status()
      set((s) => {
        s.status = status
      })
    },

    setServer: async (url) => {
      const status = await window.api.org.setServer(url)
      set((s) => {
        s.status = status
        s.scopes = []
      })
      return status
    },

    login: async (username, password) => {
      set((s) => {
        s.loggingIn = true
      })
      try {
        const res = await window.api.org.login(username, password)
        if (res.ok) {
          const [status, scopes] = await Promise.all([
            window.api.org.status(),
            window.api.org.scopes()
          ])
          set((s) => {
            s.status = status
            s.scopes = scopes
          })
        }
        return { ok: res.ok, error: res.error }
      } finally {
        set((s) => {
          s.loggingIn = false
        })
      }
    },

    logout: async () => {
      await window.api.org.logout()
      const status = await window.api.org.status()
      set((s) => {
        s.status = status
        s.scopes = []
      })
    },

    sync: async () => {
      set((s) => {
        s.syncing = true
      })
      try {
        const res = await window.api.org.sync()
        await get().refreshStatus()
        return { ok: res.ok, error: res.error }
      } finally {
        set((s) => {
          s.syncing = false
        })
      }
    },

    setAskScope: (scope) =>
      set((s) => {
        s.askScope = scope
      }),

    retrieve: (query, opts) => {
      // 2026-08 P0-6 隐私修复:
      // askScope='local' 时**物理上**不调用 org.retrieve(企业接口),
      // 由调用方在 UI 层走本地搜索(localSearch IPC)。即使把 scope 变
      // undefined 也不会绕过这条守门——网络层有第二道断言。
      const s = get()
      const askScope = s.askScope
      if (askScope === 'local') {
        // 短路:不发起任何远程调用,直接返回空结果(UI 应优先调 localSearch)
        return Promise.resolve({
          chunks: [],
          memories: [],
          suggestAsk: [],
          diagnostics: {
            bm25Hits: 0,
            vecHits: 0,
            fusedCandidates: 0,
            rerankMs: 0,
            rerankSkipped: true,
            totalMs: 0
          }
        } as RetrieveResult)
      }
      const scopesParam =
        askScope === 'org' ? (['org'] as const) :
        askScope === 'team' ? (['team'] as const) :
        undefined // 'all' 走服务端拉全部
      return window.api.org.retrieve(query, { ...(opts ?? {}), scopes: scopesParam as Array<'org' | 'team'> | undefined })
    },

    promote: (req) => window.api.org.promote(req),

    myPromotions: () => window.api.org.myPromotions()
  }))
)
