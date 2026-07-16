/**
 * 业务常量与枚举
 */

/**
 * 路由路径常量(router 与页面跳转统一引用,禁止手写字符串)
 * 注意: plop-route-constant 标记勿删,npm run new:page 自动在其上方插入新路由
 */
export const ROUTES = {
  /** Agent 工作台 */
  chat: '/chat',
  /** 知识库 */
  knowledge: '/knowledge',
  /** 技能库 */
  skills: '/skills',
  /** 自动化入口 */
  channels: '/channels',
  /** 设置 */
  settings: '/settings',
  /** 首次运行引导 */
  onboarding: '/onboarding',
  /** 登录页 */
  login: '/login',
  /** 示例页(基建演示) */
  example: '/example',
  /** Memory 页 */
  memory: '/memory',
  /** 管理页(仅管理员) */
  admin: '/admin',
  /** 会议记录 */
  meeting: '/meeting',
  /** kb 资料库 */
  kbLibrary: '/kb-library',
  /** kb 资料问答 */
  kbQa: '/kb-qa',
  /** 模型管理 */
  models: '/models',
  /** 供应商管理 */
  providers: '/providers'
  // plop-route-constant
} as const

/** 本地存储 key 收口(storage.get/set 统一引用) */
export const STORAGE_KEYS = {
  /** 示例:最后访问的路由 */
  lastRoute: 'app.lastRoute',
  /** 置顶的会话列表 */
  pinnedSessions: 'chat.pinnedSessions'
} as const
