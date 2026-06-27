import { describe, expect, it } from 'vitest'
import { pptManifest } from '../manifest'
import { PPT_PROMPT } from '../prompt'

describe('ppt skill metadata', () => {
  it('manifest 暴露稳定 id/triggers，prompt 明确工具入参和输出', () => {
    expect(pptManifest).toMatchObject({
      id: 'ppt',
      label: 'PPT 生成',
      kind: 'code'
    })
    expect(pptManifest.triggers).toEqual(expect.arrayContaining(['ppt', '幻灯片', 'powerpoint']))
    expect(PPT_PROMPT).toContain('generate_ppt')
    expect(PPT_PROMPT).toContain('"slides"')
    expect(PPT_PROMPT).toContain('{ path, slideCount }')
  })
})
