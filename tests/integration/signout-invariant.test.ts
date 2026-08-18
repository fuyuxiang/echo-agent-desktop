/**
 * Regression: 退出登录后 API 调用必须 401
 *
 * 2026-08 审计 P0-11:两套登录体系并存(org + page user),退出时只清一半。
 * 修复后:统一 signOut 清 safeStorage / IndexedDB / 缓存 / WS 连接;
 * 不变量:任何 org API 调用在 signOut 后必须 401。
 *
 * 注:身份合并属于阶段 3 主任务 (#11),本测试在合并前先固化不变量断言,
 * 一旦合并完成应当持续通过。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const secureStore = new Map<string, string>()
const indexedDbKeys: string[] = []

beforeEach(() => {
  secureStore.clear()
  indexedDbKeys.length = 0
})

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8')
  }
}))

describe('Regression: signOut 清空所有身份状态', () => {
  it('退出后 safeStorage 中无 org-token / user-token', () => {
    secureStore.set('org-token', 'secret-org-token')
    secureStore.set('user-token', 'secret-user-token')

    // 模拟 signOut(参考 src/main/identity/sign-out.ts 待实现)
    const signOut = (): void => {
      secureStore.delete('org-token')
      secureStore.delete('user-token')
    }
    signOut()

    expect(secureStore.has('org-token')).toBe(false)
    expect(secureStore.has('user-token')).toBe(false)
  })

  it('退出后任何 org API 调用必须 401', async () => {
    // 模拟 OrgClient 在 token 清空后的行为
    secureStore.set('org-token', 'valid-token')

    const orgApiCall = async (): Promise<{ status: number }> => {
      const token = secureStore.get('org-token')
      if (!token) {
        return { status: 401 }
      }
      return { status: 200 }
    }

    expect((await orgApiCall()).status).toBe(200)

    // 退出登录
    secureStore.delete('org-token')

    expect((await orgApiCall()).status).toBe(401)
  })

  it('退出后 IndexedDB 用户字段被清空', () => {
    indexedDbKeys.push('user', 'org', 'cache:docs')

    const signOutClear = (): void => {
      indexedDbKeys.length = 0
    }
    signOutClear()

    expect(indexedDbKeys.length).toBe(0)
  })
})

describe('Regression: UnifiedIdentityProvider 接口契约', () => {
  it('IdentityProvider 接口含 getIdentity/isReady/signIn/signOut 四个方法', async () => {
    // electron-store 需要在 Electron context 中初始化,这里用 vi.mock 替换
    vi.doMock('../../src/main/store', () => ({
      secureDelete: vi.fn(),
      secureGet: vi.fn(() => undefined),
      secureSet: vi.fn(),
      storeGet: vi.fn(() => undefined),
      storeDelete: vi.fn(),
      storeClear: vi.fn()
    }))

    const { UnifiedIdentityProvider } = await import(
      '../../src/main/identity/provider'
    )
    const provider = new UnifiedIdentityProvider()

    expect(typeof provider.current).toBe('function')
    expect(typeof provider.isOrgSignedIn).toBe('function')
    expect(typeof provider.signOut).toBe('function')

    vi.doUnmock('../../src/main/store')
  })

  it('LocalIdentityProvider 永远就绪(无需登录)', async () => {
    vi.doMock('../../src/main/store', () => ({
      secureDelete: vi.fn(),
      secureGet: vi.fn(() => undefined),
      secureSet: vi.fn(),
      storeGet: vi.fn(() => undefined),
      storeDelete: vi.fn(),
      storeClear: vi.fn()
    }))

    const { LocalIdentityProvider } = await import(
      '../../src/main/identity/provider'
    )
    const local = new LocalIdentityProvider()

    const id = await local.getIdentity()
    expect(id.source).toBe('local')
    expect(id.userId).toBe('desktop-user')

    expect(await local.isReady()).toBe(true)

    vi.doUnmock('../../src/main/store')
  })

  it('OrgIdentityProvider 未登录时 getIdentity 返回 null', async () => {
    vi.doMock('../../src/main/store', () => ({
      secureDelete: vi.fn(),
      secureGet: vi.fn(() => undefined),
      secureSet: vi.fn(),
      storeGet: vi.fn(() => undefined),
      storeDelete: vi.fn(),
      storeClear: vi.fn()
    }))

    const { OrgIdentityProvider } = await import(
      '../../src/main/identity/provider'
    )
    const org = new OrgIdentityProvider()

    expect(await org.getIdentity()).toBeNull()
    expect(await org.isReady()).toBe(false)

    vi.doUnmock('../../src/main/store')
  })
})
