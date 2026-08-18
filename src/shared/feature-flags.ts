/**
 * 功能开关(feature flags)
 *
 * 设计原则(2026-08 P1-1):
 * - 未完成/未实现的入口**绝不能**渲染到 UI 上 → featureFlag.enabled=false 时路由不存在
 * - 切勿把"暂未提供"作为界面文案暴露给最终用户 → 路由层兜底为"即将上线"占位
 * - 开关常量化,不允许运行时动态开启(避免灰度误用导致部分用户看到空功能)
 *
 * 添加新功能时:
 * 1. 默认 enabled = false
 * 2. 在 router 的 routes 表加 path + enabled:false
 * 3. 实装完成后改为 true,并在 PR 描述里写明 DoD
 */
export const FEATURE_FLAGS = {
  /** 知识库(Library) - 暂未实装 */
  knowledge: false,
  /** 知识库 QA - 暂未实装 */
  kbQa: false,
  /** 项目记忆共享 → 组织知识 */
  projectMemoryPromote: false,
  /** 会议纪要自动提炼组织知识 */
  meetingExtractCandidates: true,
  /** 灵魂配置 */
  soul: true,
  /** 看板 */
  kanban: true,
  /** 消息网关(企业 IM 集成) */
  gateway: true,
  /** 备份恢复 */
  backup: true,
  /** 定时任务 */
  schedules: true,
  /** Skills 发现 */
  skillsDiscover: true
} as const

export type FeatureFlagKey = keyof typeof FEATURE_FLAGS

/**
 * 路由启用判定:未实现的入口返回 false → 路由表不收录 → 用户访问得到"即将上线"占位。
 */
export function isFeatureEnabled(key: FeatureFlagKey): boolean {
  return FEATURE_FLAGS[key] === true
}
