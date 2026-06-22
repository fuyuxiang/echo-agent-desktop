import { describe, it, expect } from 'vitest'
import { buildPptPrompt, type PptOptions } from '../pptPrompt'

const base: PptOptions = {
  topic: '季度复盘',
  pages: 12,
  lang: 'zh',
  themeColor: '#1F6FEB',
  withImages: false,
  extra: '面向管理层'
}

describe('buildPptPrompt', () => {
  it('含主题、页数、主题色与读规范引导', () => {
    const p = buildPptPrompt(base)
    expect(p).toContain('季度复盘')
    expect(p).toContain('12')
    expect(p).toContain('#1F6FEB')
    expect(p).toContain('design-guide.md')
    expect(p).toContain('面向管理层')
  })

  it('withImages=false 时声明不配图', () => {
    expect(buildPptPrompt(base)).toContain('不需要配图')
  })

  it('extra 为空时不报错且省略补充段', () => {
    const p = buildPptPrompt({ ...base, extra: '' })
    expect(p).not.toContain('补充要求')
  })
})
