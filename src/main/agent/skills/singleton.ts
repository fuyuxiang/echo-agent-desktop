// src/main/agent/skills/singleton.ts
import { SkillManager } from './SkillManager'
import { builtinSkillModules } from './registry'

let instance: SkillManager | null = null

/** 懒构造单例。内置技能静态登记,无运行时配置依赖。 */
export function getSkillManager(): SkillManager {
  if (!instance) instance = new SkillManager(builtinSkillModules())
  return instance
}

export function resetSkillManagerForTest(m?: SkillManager | null): void {
  instance = m ?? null
}
