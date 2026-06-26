import { describe, it, expectTypeOf } from 'vitest'
import type { SkillManifest, SkillModule } from '../types'

describe('skills types', () => {
  it('SkillManifest 形状', () => {
    const m: SkillManifest = { id: 'ppt', label: 'PPT', description: 'd', kind: 'code' }
    expectTypeOf(m.kind).toEqualTypeOf<'prompt' | 'code'>()
  })
  it('SkillModule 形状', () => {
    const mod: SkillModule = {
      manifest: { id: 'x', label: 'X', description: 'd', kind: 'prompt' },
      promptFragment: '',
      tools: []
    }
    expectTypeOf(mod.tools).toEqualTypeOf<import('../../tools/base').Tool[]>()
  })
})
