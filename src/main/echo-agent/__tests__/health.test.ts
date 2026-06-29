import { describe, it, expect, vi } from 'vitest'
import { waitHealthy } from '../health'

describe('waitHealthy', () => {
  it('returns true once health endpoint responds ok', async () => {
    let n = 0
    const fetchFn = vi.fn(async () => ({ ok: ++n >= 3 }))
    const ok = await waitHealthy('http://127.0.0.1:9', {
      timeoutMs: 10_000, intervalMs: 1, fetchFn, sleep: async () => {}, now: () => 0
    })
    expect(ok).toBe(true)
    expect(fetchFn).toHaveBeenCalledWith('http://127.0.0.1:9/api/health')
    expect(n).toBe(3)
  })

  it('returns false on timeout', async () => {
    const times = [0, 4000, 8000, 12000]
    let i = 0
    const ok = await waitHealthy('http://127.0.0.1:9', {
      timeoutMs: 10_000, intervalMs: 1,
      fetchFn: async () => ({ ok: false }),
      sleep: async () => {}, now: () => times[Math.min(i++, times.length - 1)]
    })
    expect(ok).toBe(false)
  })

  it('treats fetch rejection as not-ready and keeps polling', async () => {
    let n = 0
    const fetchFn = vi.fn(async () => {
      if (++n < 2) throw new Error('conn refused')
      return { ok: true }
    })
    const ok = await waitHealthy('http://127.0.0.1:9', {
      timeoutMs: 10_000, intervalMs: 1, fetchFn, sleep: async () => {}, now: () => 0
    })
    expect(ok).toBe(true)
  })
})
