// src/main/agent/skills/registry.ts
import type { SkillModule } from './types'
import { pptManifest } from './builtin/ppt/manifest'
import { PPT_PROMPT } from './builtin/ppt/prompt'
import { generatePptTool } from './builtin/ppt/handler'

const pptModule: SkillModule = {
  manifest: pptManifest,
  promptFragment: PPT_PROMPT,
  tools: [generatePptTool]
}

/** 编译期静态登记的内置技能(首批仅 PPT)。 */
export function builtinSkillModules(): SkillModule[] {
  return [pptModule]
}
