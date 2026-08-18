/**
 * Regression: 仅本机模式零网络请求
 *
 * 2026-08 审计 P0-6:旧实现 orgStore.retrieve 在 askScope='local' 时把 scope 设为
 * undefined 后仍走 org.retrieve 企业接口,违反隐私承诺。
 * 修复后:scope='local' 时直接短路,返回空结果,不调用 org.retrieve。
 *
 * 本测试验证短路逻辑 + 第二道防线(网络层断言,见源码 net-call-interceptor.ts)。
 */
import { describe, it, expect, beforeEach } from 'vitest'

const orgRetrieveCalls: Array<unknown[]> = []

beforeEach(() => {
  orgRetrieveCalls.length = 0
  // 重置 window.api.org mock
  ;(globalThis as unknown as { window: { api: { org: unknown } } }).window = {
    api: {
      org: {
        retrieve: (...args: unknown[]) => {
          orgRetrieveCalls.push(args)
          return Promise.resolve({ chunks: [], memories: [], diagnostics: {} })
        },
        status: () => Promise.resolve(null),
        onStatusChanged: () => () => {}
      }
    }
  }
})

describe('Regression: askScope=local 时不发起远程请求', () => {
  it('orgStore.retrieve 短路返回空结果', async () => {
    const { useOrgStore } = await import('@/stores/orgStore')

    const store = useOrgStore.getState()
    store.setAskScope('local')

    const res = await store.retrieve('住宿标准', { limit: 8 })

    expect(res.chunks).toEqual([])
    expect(res.memories).toEqual([])
    // 关键断言:org.retrieve 不应被调用
    expect(orgRetrieveCalls.length).toBe(0)
  })

  it('askScope=org 时仍正常调用企业检索', async () => {
    const { useOrgStore } = await import('@/stores/orgStore')
    const store = useOrgStore.getState()
    store.setAskScope('org')

    await store.retrieve('差旅标准', { limit: 5 })

    expect(orgRetrieveCalls.length).toBe(1)
    expect(orgRetrieveCalls[0][1]).toMatchObject({ scopes: ['org'] })
  })

  it('askScope=all 不带 scopes 过滤(服务端拉全部)', async () => {
    const { useOrgStore } = await import('@/stores/orgStore')
    const store = useOrgStore.getState()
    store.setAskScope('all')

    await store.retrieve('test', { limit: 5 })

    expect(orgRetrieveCalls.length).toBe(1)
    // scopes 应为 undefined(全开放)
    const opts = orgRetrieveCalls[0][1] as { scopes?: string[] }
    expect(opts.scopes).toBeUndefined()
  })
})
