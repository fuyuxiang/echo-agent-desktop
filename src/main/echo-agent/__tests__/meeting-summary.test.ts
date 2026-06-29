import { describe, it, expect, vi } from 'vitest'
import { buildSummaryPrompt, parseSummary, buildNotifyMessage, summarizeMeeting } from '../meeting-summary'
import type { ChatProvider } from '../../agent/providers/types'
import type { SegmentDTO } from '@shared/types/meeting'

vi.mock('electron-log/main', () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

vi.mock('../llm', () => ({
  getLLMProvider: vi.fn(() => null),
  getLLMConfig: vi.fn(() => ({ baseUrl: '', apiKey: '', model: 'test-model' }))
}))

function seg(idx: number, text: string, speaker: string | null): SegmentDTO {
  return { id: idx, meetingId: 'm1', idx, startMs: 0, endMs: 0, text, speaker, createdAt: 0 }
}
function fakeProvider(out: string): ChatProvider {
  return { chat: async function* (): any { yield { type: 'text', text: out } } } as unknown as ChatProvider
}
function errorProvider(): ChatProvider {
  return {
    chat: async function* (): any { yield { type: 'error', message: 'boom' } }
  } as unknown as ChatProvider
}
function throwingProvider(): ChatProvider {
  return {
    chat: function (): any { throw new Error('chat failed') }
  } as unknown as ChatProvider
}

describe('buildSummaryPrompt', () => {
  it('includes speaker-prefixed transcript and markdown headers', () => {
    const p = buildSummaryPrompt([seg(0, '今天讨论上线', 'A'), seg(1, '好的', null)])
    expect(p).toContain('[A] 今天讨论上线')
    expect(p).toContain('好的')
    expect(p).toContain('## 摘要')
    expect(p).toContain('## 关键点')
    expect(p).toContain('## 待办')
  })
})

describe('parseSummary', () => {
  it('extracts summary, key points and action items', () => {
    const md = '## 摘要\n讨论了上线计划\n## 关键点\n- 周五发布\n- 灰度 10%\n## 待办\n- 张三写脚本'
    expect(parseSummary(md)).toEqual({
      summary: '讨论了上线计划',
      keyPoints: ['周五发布', '灰度 10%'],
      actionItems: ['张三写脚本']
    })
  })
  it('treats 无 as empty action items', () => {
    const md = '## 摘要\nX\n## 关键点\n- a\n## 待办\n无'
    expect(parseSummary(md).actionItems).toEqual([])
  })
})

describe('buildNotifyMessage', () => {
  it('is a short message with title, summary and todos (not the transcript)', () => {
    const msg = buildNotifyMessage('上线评审会', {
      summary: '讨论了上线计划', keyPoints: ['周五发布'], actionItems: ['张三写脚本']
    })
    expect(msg).toContain('上线评审会')
    expect(msg).toContain('讨论了上线计划')
    expect(msg).toContain('张三写脚本')
  })
})

describe('summarizeMeeting', () => {
  it('returns null when no provider available', async () => {
    await expect(summarizeMeeting([seg(0, 'x', null)])).resolves.toBeNull()
  })
  it('summarizes via injected provider and parses result', async () => {
    const provider = fakeProvider('## 摘要\n概括\n## 关键点\n- k1\n## 待办\n无')
    const r = await summarizeMeeting([seg(0, '内容', 'A')], { provider })
    expect(r).toEqual({ summary: '概括', keyPoints: ['k1'], actionItems: [] })
  })
  it('returns null when provider yields an error delta', async () => {
    const r = await summarizeMeeting([seg(0, '内容', 'A')], { provider: errorProvider() })
    expect(r).toBeNull()
  })
  it('returns null (does not throw) when provider chat throws', async () => {
    await expect(
      summarizeMeeting([seg(0, '内容', 'A')], { provider: throwingProvider() })
    ).resolves.toBeNull()
  })
})
