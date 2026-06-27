import { describe, it, expect } from 'vitest'
import { sanitizeTitle } from '../title'

describe('sanitizeTitle', () => {
  it('剥离 <think> 标签', () => {
    expect(sanitizeTitle('<think>琢磨一下</think>Python 快排')).toBe('Python 快排')
  })

  it('去掉包裹引号', () => {
    expect(sanitizeTitle('「周末出游建议」')).toBe('周末出游建议')
    expect(sanitizeTitle('"数据分析"')).toBe('数据分析')
  })

  it('去掉首尾标点与空白', () => {
    expect(sanitizeTitle('  快速排序。 ')).toBe('快速排序')
  })

  it('只取第一行', () => {
    expect(sanitizeTitle('标题在这里\n这是多余的解释')).toBe('标题在这里')
  })

  it('超长截断到 15 字', () => {
    const long = '一二三四五六七八九十一二三四五六七八'
    expect(sanitizeTitle(long).length).toBe(15)
  })

  it('空输入返回空串', () => {
    expect(sanitizeTitle('')).toBe('')
    expect(sanitizeTitle('   ')).toBe('')
  })
})
