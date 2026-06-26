// src/main/agent/tools/skill-facade.ts
import type { Tool } from './base'

/** 技能门面(P2 冻结接口,P4 实现真实逻辑) */
export interface SkillGateway {
  /** 已激活技能注入系统上下文的提示片段 */
  activePromptFragments(): string[]
  /** 已激活技能贡献给 registry 的工具 */
  tools(): Tool[]
}

/** P2 占位实现: 无激活技能 */
export class NoopSkillGateway implements SkillGateway {
  activePromptFragments(): string[] {
    return []
  }
  tools(): Tool[] {
    return []
  }
}
