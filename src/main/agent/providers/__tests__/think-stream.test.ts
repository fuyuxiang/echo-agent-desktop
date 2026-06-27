import { describe, it, expect } from 'vitest'
import { ThinkTagSplitter, type ThinkPiece } from '../think-stream'

/** 把多段 chunk 喂进 splitter,收集所有输出,末尾 flush */
function run(chunks: string[]): ThinkPiece[] {
  const s = new ThinkTagSplitter()
  const out: ThinkPiece[] = []
  for (const c of chunks) out.push(...s.push(c))
  out.push(...s.flush())
  return out
}

/** 按 kind 聚合最终文本,便于断言 */
function collect(chunks: string[]): { text: string; reasoning: string } {
  let text = ''
  let reasoning = ''
  for (const p of run(chunks)) {
    if (p.kind === 'text') text += p.text
    else reasoning += p.text
  }
  return { text, reasoning }
}

describe('ThinkTagSplitter', () => {
  it('一次性完整 think 标签', () => {
    const r = collect(['<think>分析问题</think>你好'])
    expect(r.reasoning).toBe('分析问题')
    expect(r.text).toBe('你好')
  })

  it('无标签纯文本原样透传', () => {
    const r = collect(['你好,', '世界'])
    expect(r.reasoning).toBe('')
    expect(r.text).toBe('你好,世界')
  })

  it('标签字面量绝不泄漏到正文', () => {
    for (const p of run(['<think>思考</think>正文'])) {
      expect(p.text).not.toContain('<think>')
      expect(p.text).not.toContain('</think>')
    }
  })

  it('开标签被切在 chunk 边界', () => {
    const r = collect(['好的<thi', 'nk>琢磨</think>答案'])
    expect(r.text).toBe('好的答案')
    expect(r.reasoning).toBe('琢磨')
  })

  it('闭标签被切在 chunk 边界', () => {
    const r = collect(['<think>琢磨</thi', 'nk>答案'])
    expect(r.text).toBe('答案')
    expect(r.reasoning).toBe('琢磨')
  })

  it('逐字符流式喂入', () => {
    const src = '前言<think>推理过程</think>结论'
    const r = collect(src.split(''))
    expect(r.text).toBe('前言结论')
    expect(r.reasoning).toBe('推理过程')
  })

  it('reasoning 内容在闭合前不泄漏(中间态)', () => {
    const s = new ThinkTagSplitter()
    const early = s.push('<think>正在分析')
    // 还没闭合,绝不能作为 text 吐出
    expect(early.every((p) => p.kind !== 'text' || p.text === '')).toBe(true)
    const rest = s.push('完毕</think>结果')
    const all = [...early, ...rest, ...s.flush()]
    const text = all.filter((p) => p.kind === 'text').map((p) => p.text).join('')
    expect(text).toBe('结果')
  })

  it('未闭合标签:flush 时把残留按 reasoning 吐出,不丢内容', () => {
    const r = collect(['正文<think>没闭合的思考'])
    expect(r.text).toBe('正文')
    expect(r.reasoning).toBe('没闭合的思考')
  })

  it('<thinking> 标签变体', () => {
    const r = collect(['<thinking>想一下</thinking>好的'])
    expect(r.reasoning).toBe('想一下')
    expect(r.text).toBe('好的')
  })

  it('大小写不敏感', () => {
    const r = collect(['<THINK>大写</THINK>正文'])
    expect(r.reasoning).toBe('大写')
    expect(r.text).toBe('正文')
  })

  it('多个 think 段', () => {
    const r = collect(['<think>一</think>中间<think>二</think>尾'])
    expect(r.reasoning).toBe('一二')
    expect(r.text).toBe('中间尾')
  })

  it('正文中的 < 号不被误判为标签', () => {
    const r = collect(['a < b 且 c > d'])
    expect(r.text).toBe('a < b 且 c > d')
    expect(r.reasoning).toBe('')
  })

  it('末尾孤立的 < 在 flush 时作为正文吐出', () => {
    const r = collect(['结果是 5 <'])
    expect(r.text).toBe('结果是 5 <')
  })
})
