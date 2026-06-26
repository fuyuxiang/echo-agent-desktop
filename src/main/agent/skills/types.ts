// src/main/agent/skills/types.ts
import type { Tool } from '../tools/base'

/** 技能清单(manifest) */
export interface SkillManifest {
  id: string
  label: string
  description: string
  kind: 'prompt' | 'code'
  /** 自动触发关键词(预留,P4 不实现自动触发) */
  triggers?: string[]
}

/** 一个可注册的技能模块 */
export interface SkillModule {
  manifest: SkillManifest
  /** 激活时注入 system 的提示片段 */
  promptFragment: string
  /** 代码型技能贡献的工具(prompt 型为空数组) */
  tools: Tool[]
}
