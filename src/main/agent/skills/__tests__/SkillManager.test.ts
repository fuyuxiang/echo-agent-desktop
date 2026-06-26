import { describe, it, expect } from 'vitest'
import { SkillManager } from '../SkillManager'
import type { SkillModule } from '../types'
import type { Tool } from '../../tools/base'

const fakeTool: Tool = {
  name: 'generate_ppt',
  description: 'd',
  parameters: { type: 'object', properties: {} },
  async execute() { return { ok: true, content: 'ok' } }
}
const mods: SkillModule[] = [
  { manifest: { id: 'ppt', label: 'PPT', description: 'd', kind: 'code' }, promptFragment: 'PPT_PROMPT', tools: [fakeTool] }
]

describe('SkillManager', () => {
  it('list 返回所有已注册 manifest', () => {
    expect(new SkillManager(mods).list().map((m) => m.id)).toEqual(['ppt'])
  })
  it('未激活时 chatId 的 fragments/tools 为空', () => {
    const m = new SkillManager(mods)
    expect(m.activePromptFragments('c1')).toEqual([])
    expect(m.tools('c1')).toEqual([])
  })
  it('activate 后该会话可见 fragment 与工具', () => {
    const m = new SkillManager(mods)
    m.activate('c1', 'ppt')
    expect(m.activePromptFragments('c1')).toEqual(['PPT_PROMPT'])
    expect(m.tools('c1').map((t) => t.name)).toEqual(['generate_ppt'])
    expect(m.activeIds('c1')).toEqual(['ppt'])
  })
  it('激活态按会话隔离', () => {
    const m = new SkillManager(mods)
    m.activate('c1', 'ppt')
    expect(m.tools('c2')).toEqual([])
  })
  it('deactivate 移除激活态', () => {
    const m = new SkillManager(mods)
    m.activate('c1', 'ppt')
    m.deactivate('c1', 'ppt')
    expect(m.activeIds('c1')).toEqual([])
  })
  it('activate 未知技能 id 安全忽略', () => {
    const m = new SkillManager(mods)
    m.activate('c1', 'nope')
    expect(m.activeIds('c1')).toEqual([])
  })
})
