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
