import { describe, it, expect } from 'vitest'
import { groupSessions } from '../group'
import type { ChatSession } from '@/stores/chatStore'

const DAY = 86_400_000
// 固定 now 到某天正午,避免边界时区误差
const NOW = new Date('2026-06-15T12:00:00').getTime()

function makeSession(over: Partial<ChatSession> & { chatId: string }): ChatSession {
  return {
    chatId: over.chatId,
    title: over.title ?? over.chatId,
    platform: 'desktop',
    lastActivity: over.lastActivity ?? NOW,
    messageCount: over.messageCount ?? 1,
    pinned: over.pinned ?? false
  }
}

describe('groupSessions', () => {
  it('置顶会话独立成组且排在最前,不按时间细分', () => {
    const sessions = [
      makeSession({ chatId: 'pin-old', pinned: true, lastActivity: NOW - 100 * DAY }),
      makeSession({ chatId: 'today', lastActivity: NOW })
    ]
    const groups = groupSessions(sessions, NOW)
    expect(groups[0].key).toBe('pinned')
    expect(groups[0].sessions.map((s) => s.chatId)).toEqual(['pin-old'])
    expect(groups[1].key).toBe('today')
  })

  it('按今天/昨天/7天内/30天内/更早分桶', () => {
    const sessions = [
      makeSession({ chatId: 'today', lastActivity: NOW - 1000 }),
      makeSession({ chatId: 'yest', lastActivity: NOW - 1.2 * DAY }),
      makeSession({ chatId: 'week', lastActivity: NOW - 4 * DAY }),
      makeSession({ chatId: 'month', lastActivity: NOW - 20 * DAY }),
      makeSession({ chatId: 'old', lastActivity: NOW - 200 * DAY })
    ]
    const groups = groupSessions(sessions, NOW)
    expect(groups.map((g) => g.key)).toEqual(['today', 'yesterday', 'week', 'month', 'earlier'])
  })

  it('空组不返回', () => {
    const sessions = [makeSession({ chatId: 'today', lastActivity: NOW })]
    const groups = groupSessions(sessions, NOW)
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('today')
  })

  it('空列表返回空数组', () => {
    expect(groupSessions([], NOW)).toEqual([])
  })

  it('分组有正确的中文标签', () => {
    const sessions = [makeSession({ chatId: 'p', pinned: true })]
    expect(groupSessions(sessions, NOW)[0].label).toBe('置顶')
  })
})
