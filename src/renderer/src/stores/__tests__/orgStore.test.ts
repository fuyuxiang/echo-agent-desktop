import { describe, it, expect, vi, afterEach } from 'vitest'
import { useOrgStore, isOrgReady, isCacheStale } from '../orgStore'
import type { OrgStatus } from '@shared/types/org'

function status(over: Partial<OrgStatus> = {}): OrgStatus {
  return {
    configured: true,
    serverUrl: 'https://echo.test',
    loggedIn: true,
    user: null,
    reachable: true,
    lastSyncAt: Date.now(),
    cachedDocs: 3,
    cachedChunks: 12,
    ...over
  }
}

describe('isOrgReady', () => {
  it('已配置且已登录才算就绪', () => {
    expect(isOrgReady(status())).toBe(true)
    expect(isOrgReady(status({ loggedIn: false }))).toBe(false)
    expect(isOrgReady(status({ configured: false }))).toBe(false)
    expect(isOrgReady(null)).toBe(false)
  })
})

describe('isCacheStale', () => {
  it('超过一天未同步视为陈旧', () => {
    const now = Date.now()
    expect(isCacheStale(status({ lastSyncAt: now - 2 * 3600_000 }), now)).toBe(false)
    expect(isCacheStale(status({ lastSyncAt: now - 25 * 3600_000 }), now)).toBe(true)
  })

  it('从未同步不算陈旧(避免刚登录就报警)', () => {
    expect(isCacheStale(status({ lastSyncAt: null }))).toBe(false)
    expect(isCacheStale(null)).toBe(false)
  })
})

// 升级过程中可能出现老 preload 配新渲染层。少了这道判断,init() 会抛出
// 无人接管的 rejection,把挂了企业组件的整个页面(如会议详情)拖垮。
describe('org 桥接缺失时的降级', () => {
  const original = (globalThis as { window?: unknown }).window

  afterEach(() => {
    ;(globalThis as { window?: unknown }).window = original
    useOrgStore.setState({ status: null, scopes: [] })
  })

  it('window.api 缺 org 时 init 不抛错', async () => {
    ;(globalThis as { window?: unknown }).window = { api: {} }
    await expect(useOrgStore.getState().init()).resolves.toBeUndefined()
    expect(useOrgStore.getState().status).toBeNull()
  })

  it('window.api 完全缺失时 init 不抛错', async () => {
    ;(globalThis as { window?: unknown }).window = {}
    await expect(useOrgStore.getState().init()).resolves.toBeUndefined()
  })

  it('桥接缺失时 refreshStatus 不抛错', async () => {
    ;(globalThis as { window?: unknown }).window = { api: {} }
    await expect(useOrgStore.getState().refreshStatus()).resolves.toBeUndefined()
  })

  it('桥接可用时正常读取状态', async () => {
    const s = status()
    ;(globalThis as { window?: unknown }).window = {
      api: {
        org: {
          status: vi.fn(async () => s),
          scopes: vi.fn(async () => [{ id: 's1', kind: 'org', name: '全公司', groupId: null }]),
          onStatusChanged: vi.fn(() => () => {})
        }
      }
    }
    await useOrgStore.getState().init()
    expect(useOrgStore.getState().status).toEqual(s)
    expect(useOrgStore.getState().scopes).toHaveLength(1)
  })
})
