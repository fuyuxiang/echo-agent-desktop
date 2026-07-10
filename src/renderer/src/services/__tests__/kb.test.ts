import { describe, it, expect, vi, beforeEach } from 'vitest'
import { askKb, type KbAskRequest } from '../kb'
import { request } from '@/request'

vi.mock('@/request', () => ({
  request: { get: vi.fn(), post: vi.fn() }
}))

describe('kb service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('askKb posts query+topK to /api/kb/ask and unwraps BaseData', async () => {
    ;(request.post as any).mockResolvedValue({
      answer: 'a',
      citations: [],
      confidence: 'high'
    })
    const r = await askKb({ query: 'foo', topK: 5 } as KbAskRequest)
    expect(r.answer).toBe('a')
    expect(request.post).toHaveBeenCalledWith('/api/kb/ask', { query: 'foo', topK: 5 })
  })
})
