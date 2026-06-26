// src/main/agent/tools/skill-facade.ts
import type { Tool } from './base'

/** 技能门面(P4 加 chatId,补 P2 冻结接口的 per-chatId 缺口) */
export interface SkillGateway {
  /** 已激活技能注入系统上下文的提示片段 */
  activePromptFragments(chatId: string): string[]
  /** 已激活技能贡献给 registry 的工具 */
  tools(chatId: string): Tool[]
}

/** P2 占位实现: 无激活技能 */
export class NoopSkillGateway implements SkillGateway {
  activePromptFragments(_chatId: string): string[] {
    return []
  }
  tools(_chatId: string): Tool[] {
    return []
  }
}
