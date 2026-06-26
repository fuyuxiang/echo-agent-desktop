import { describe, it, expect } from 'vitest'
import { builtinSkillModules } from '../registry'

describe('builtinSkillModules', () => {
  it('包含 ppt 代码型技能且带 generate_ppt 工具', () => {
    const mods = builtinSkillModules()
    const ppt = mods.find((m) => m.manifest.id === 'ppt')
    expect(ppt).toBeDefined()
    expect(ppt!.manifest.kind).toBe('code')
    expect(ppt!.tools.map((t) => t.name)).toContain('generate_ppt')
    expect(ppt!.promptFragment.length).toBeGreaterThan(0)
  })
})
