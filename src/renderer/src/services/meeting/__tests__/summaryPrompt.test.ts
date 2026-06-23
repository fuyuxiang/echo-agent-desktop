import { describe, it, expect } from 'vitest'
import { buildSummaryPrompt, parseSummary } from '../summarize'
import type { SegmentDTO } from '@shared/types/meeting'

const seg = (idx: number, text: string, speaker: string | null = null): SegmentDTO => ({
  id: idx, meetingId: 'm', idx, startMs: idx * 1000, endMs: idx * 1000 + 900,
  text, speaker, createdAt: 0
})

describe('buildSummaryPrompt', () => {
  it('包含全文与三段式指令', () => {
    const p = buildSummaryPrompt([seg(0, '讨论目标'), seg(1, '分配任务', 'speaker_1')])
    expect(p).toContain('讨论目标')
    expect(p).toContain('分配任务')
    expect(p).toContain('摘要')
    expect(p).toContain('关键点')
    expect(p).toContain('待办')
  })
})

describe('parseSummary', () => {
  it('解析三段标记', () => {
    const text = [
      '## 摘要', '这是摘要正文。',
      '## 关键点', '- 点1', '- 点2',
      '## 待办', '- 待办1'
    ].join('\n')
    const r = parseSummary(text)
    expect(r.summary).toContain('这是摘要正文')
    expect(r.keyPoints).toEqual(['点1', '点2'])
    expect(r.actionItems).toEqual(['待办1'])
  })
  it('缺失段落时返回空数组', () => {
    const r = parseSummary('## 摘要\n只有摘要')
    expect(r.summary).toContain('只有摘要')
    expect(r.keyPoints).toEqual([])
    expect(r.actionItems).toEqual([])
  })
})
