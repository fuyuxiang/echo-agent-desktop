import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SegmentDTO } from '@shared/types/meeting'

describe('generateSummary', () => {
  beforeEach(() => {
    ;(globalThis as any).window = {
      api: {
        meeting: {
          summarize: vi.fn(async () => ({ summary: 's', keyPoints: ['k'], actionItems: [] })),
          setSummary: vi.fn(async () => undefined)
        }
      }
    }
  })

  it('calls summarize then persists parsed summary', async () => {
    const { generateSummary } = await import('../summarize')
    const segs: SegmentDTO[] = [
      { id: 0, meetingId: 'm1', idx: 0, startMs: 0, endMs: 0, text: 'x', speaker: null, createdAt: 0 }
    ]
    await generateSummary('m1', segs, '评审会')
    expect(window.api.meeting.summarize).toHaveBeenCalledWith('m1', '评审会', segs)
    expect(window.api.meeting.setSummary).toHaveBeenCalledWith('m1', {
      summary: 's', keyPoints: ['k'], actionItems: [], model: 'desktop-llm'
    })
  })

  it('throws when summarize returns null (caller surfaces failure)', async () => {
    ;(window.api.meeting.summarize as any).mockResolvedValueOnce(null)
    const { generateSummary } = await import('../summarize')
    await expect(generateSummary('m1', [], 't')).rejects.toThrow()
  })
})
