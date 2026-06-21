import { describe, it, expect } from 'vitest'
import {
  SESSION_STALE_MS,
  REPLAY_ROUNDS,
  isSessionStale,
  extractRecentRounds,
  buildPrimerText
} from '../session-history'

describe('session-history', () => {
  it('48h 常量与 6 轮常量正确', () => {
    expect(SESSION_STALE_MS).toBe(48 * 60 * 60 * 1000)
    expect(REPLAY_ROUNDS).toBe(6)
  })

  it('isSessionStale: 超过 48h 判失效, 未超过不失效', () => {
    const now = 1_000_000_000_000
    expect(isSessionStale(now - SESSION_STALE_MS - 1, now)).toBe(true)
    expect(isSessionStale(now - SESSION_STALE_MS + 1, now)).toBe(false)
  })

  it('extractRecentRounds: 取最近 N 轮(user+assistant), 过滤 system', () => {
    const msgs = [
      { role: 'system' as const, content: 's' },
      { role: 'user' as const, content: 'u1' },
      { role: 'assistant' as const, content: 'a1' },
      { role: 'user' as const, content: 'u2' },
      { role: 'assistant' as const, content: 'a2' }
    ]
    const out = extractRecentRounds(msgs, 1)
    expect(out).toEqual([
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' }
    ])
  })

  it('extractRecentRounds: 不足 N 轮时返回全部(去 system)', () => {
    const msgs = [
      { role: 'user' as const, content: 'u1' },
      { role: 'assistant' as const, content: 'a1' }
    ]
    expect(extractRecentRounds(msgs, 6)).toHaveLength(2)
  })

  it('buildPrimerText: 空数组返回空串, 非空含回顾前缀', () => {
    expect(buildPrimerText([])).toBe('')
    const text = buildPrimerText([{ role: 'user', content: '你好' }])
    expect(text).toContain('你好')
    expect(text).toContain('历史回顾')
    expect(text).toContain('不是新任务')
    expect(text.length).toBeGreaterThan('你好'.length)
  })
})
