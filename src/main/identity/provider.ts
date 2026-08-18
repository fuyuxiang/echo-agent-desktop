import { app, safeStorage } from 'electron'
import { secureDelete, secureGet, storeClear, storeDelete } from '../store'
import { log } from '../logger'

/**
 * 身份提供方抽象(2026-08 审计 P1-2 修复)
 *
 * 旧实现里"页面账号"(userStore)和"企业账号"(orgStore)互不统一,
 * 退出登录只清一半,导致"界面已退出但企业凭证仍有效"的串台问题。
 *
 * 新模型:所有身份来源实现 `IdentityProvider`,渲染端通过 `window.api.identity.*`
 * 单一入口访问;signOut() 清空所有 provider 的状态,确保一致不变量。
 *
 * 当前实现:
 * - LocalIdentityProvider:desktop-user 占位身份,不依赖外部服务
 * - OrgIdentityProvider:(待 echo-agent-server 鉴权头规范稳定后实现,本会话仅留 stub)
 *
 * 任何身份变更(登录/退出/Token 刷新)必须走 identity.signIn / identity.signOut,
 * 严禁直接改 secureStorage / store。
 */

/** 身份上下文:当前活跃身份的快照 */
export interface Identity {
  userId: string
  displayName: string
  /** 身份来源,用于 UI 区分(本地/企业) */
  source: 'local' | 'org'
  /** 当前凭证,本地身份为 desktop-user,企业身份为 server-issued token */
  token?: string
  /** 服务端角色(企业版),本地身份 undefined */
  role?: 'admin' | 'member'
  /** 关联组织/团队(企业版),本地身份 undefined */
  groups?: Array<{ id: string; name: string }>
}

export interface IdentityProvider {
  /** 提供方标识 */
  readonly source: 'local' | 'org'
  /** 获取当前身份快照(无身份时返回 null) */
  getIdentity(): Promise<Identity | null>
  /** 当前是否就绪(用于 UI 显示登录/未登录状态) */
  isReady(): Promise<boolean>
  /** 登录(silent 表示用已存的 token 复用,不弹窗) */
  signIn(opts: { username?: string; password?: string; silent?: boolean }): Promise<Identity>
  /** 登出,清空该 provider 的所有状态(token/缓存/user) */
  signOut(): Promise<void>
}

/** 加密命名空间下与身份相关的 key,signOut 时全部清空 */
const IDENTITY_SECURE_KEYS = [
  'org-token',
  'user-token',
  'openai-api-key' // API key 也属于身份密钥范畴(防止拿到 keystore 还能用)
]

/** 普通 store 中与身份相关的 key */
const IDENTITY_STORE_KEYS = [
  'org.status',
  'org.user',
  'user.profile',
  'user.session'
]

/**
 * LocalIdentityProvider:不依赖外部服务的占位身份。
 *
 * 桌面应用本机使用场景下没有"账号"概念,只需一个稳定的 userId 用于:
 * - echo-agent gateway 鉴权(platform=desktop + user_id=desktop-user)
 * - 本地记忆/项目记忆归属
 */
export class LocalIdentityProvider implements IdentityProvider {
  readonly source = 'local' as const

  async getIdentity(): Promise<Identity> {
    return {
      userId: 'desktop-user',
      displayName: 'Desktop User',
      source: 'local'
    }
  }

  async isReady(): Promise<boolean> {
    // 本地身份永远就绪(无需登录)
    return true
  }

  async signIn(): Promise<Identity> {
    // 本地身份无需登录
    return this.getIdentity()
  }

  async signOut(): Promise<void> {
    // 本地身份不需要登出,但清空可能残留的 user-token(兼容性)
    secureDelete('user-token')
    log.info('[identity/local] signOut:清空残留 user-token')
  }
}

/**
 * OrgIdentityProvider:(待 echo-agent-server 鉴权头规范稳定后实装)
 *
 * 当前实现:仅占位,真实凭证管理委托给现有 org 客户端。
 * 完整实现需要:
 * 1. 与 echo-agent-server 鉴权头规范对齐(目前 server URL/config 仍在变)
 * 2. 凭证刷新机制(refresh_token 生命周期)
 * 3. 多设备登录互踢
 *
 * 当前阶段不实装,避免在协议未定的情况下做错误承诺。
 */
export class OrgIdentityProvider implements IdentityProvider {
  readonly source = 'org' as const

  async getIdentity(): Promise<Identity | null> {
    const token = secureGet('org-token')
    if (!token) return null
    // 暂时从普通 store 读 profile(由 org 客户端写入)
    const profile = (await import('../store')).storeGet<{
      userId: string
      displayName: string
      role?: 'admin' | 'member'
      groups?: Array<{ id: string; name: string }>
    }>('org.user')
    if (!profile) return null
    return {
      userId: profile.userId,
      displayName: profile.displayName,
      source: 'org',
      token,
      role: profile.role,
      groups: profile.groups
    }
  }

  async isReady(): Promise<boolean> {
    const id = await this.getIdentity()
    return id !== null
  }

  async signIn(opts: { username?: string; password?: string }): Promise<Identity> {
    // 真实登录委托给 org 客户端,这里只占位
    if (!opts.username || !opts.password) {
      throw new Error('OrgIdentityProvider.signIn 需要 username + password')
    }
    // TODO: 等 echo-agent-server 协议稳定后,实装真实登录 + 凭证刷新
    throw new Error('OrgIdentityProvider.signIn 尚未实装,等 echo-agent-server 协议稳定')
  }

  async signOut(): Promise<void> {
    secureDelete('org-token')
    IDENTITY_STORE_KEYS.forEach((k) => storeDelete(k))
    log.info('[identity/org] signOut:清空 org-token + profile')
  }
}

/**
 * UnifiedIdentityProvider:组合多个 provider,提供"当前身份"快照与统一 signOut。
 *
 * 渲染端只通过 `window.api.identity.*` 访问本类;不直接调用 LocalIdentityProvider
 * 或 OrgIdentityProvider,以避免"退出登录只清一半"的串台 bug 重现。
 */
export class UnifiedIdentityProvider {
  private readonly local: LocalIdentityProvider
  private readonly org: OrgIdentityProvider

  constructor() {
    this.local = new LocalIdentityProvider()
    this.org = new OrgIdentityProvider()
  }

  /** 当前活跃身份(优先 org,本地兜底) */
  async current(): Promise<Identity> {
    const orgId = await this.org.getIdentity()
    if (orgId) return orgId
    return this.local.getIdentity()
  }

  /** 当前是否登录了企业账号 */
  async isOrgSignedIn(): Promise<boolean> {
    return this.org.isReady()
  }

  /**
   * 统一登出:清空所有身份相关的 safeStorage + store + 用户数据。
   *
   * 不变量(回归测试守住):
   * - signOut 后任何 org API 调用必须 401
   * - safeStorage 中无 org-token / user-token
   * - 普通 store 中无 org.user / user.profile 等身份字段
   */
  async signOut(): Promise<void> {
    log.info('[identity] signOut:清空所有身份状态')

    // 1. 清空 secure storage 中的所有身份密钥
    IDENTITY_SECURE_KEYS.forEach((k) => secureDelete(k))

    // 2. 清空普通 store 中的身份字段
    IDENTITY_STORE_KEYS.forEach((k) => storeDelete(k))

    // 3. 调用各 provider 的 signOut(让 provider 自清理缓存)
    await this.org.signOut()
    await this.local.signOut()

    log.info('[identity] signOut:完成')
  }

  /** 完全重置(测试用,清空整个 store) */
  async nuke(): Promise<void> {
    storeClear()
    log.warn('[identity] nuke:全部配置已清空')
  }

  /** 当前 safeStorage 是否可用(用于 UI 提示密钥安全状态) */
  isSecureStoreAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }
}

/** 模块级单例(测试时可替换) */
let _instance: UnifiedIdentityProvider | null = null

export function getIdentity(): UnifiedIdentityProvider {
  if (!_instance) _instance = new UnifiedIdentityProvider()
  return _instance
}

/** 测试用:替换单例 */
export function setIdentityForTest(provider: UnifiedIdentityProvider | null): void {
  _instance = provider
  // 重置模块级常量(app name)在主进程入口会读取
  void app
}
