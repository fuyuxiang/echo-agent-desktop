import type { ChatSession } from '@/stores/chatStore'

/** 会话分组的有序键(渲染按此顺序) */
export type SessionGroupKey = 'pinned' | 'today' | 'yesterday' | 'week' | 'month' | 'earlier'

export interface SessionGroup {
  key: SessionGroupKey
  label: string
  sessions: ChatSession[]
}

const GROUP_LABELS: Record<SessionGroupKey, string> = {
  pinned: '置顶',
  today: '今天',
  yesterday: '昨天',
  week: '7 天内',
  month: '30 天内',
  earlier: '更早'
}

const GROUP_ORDER: SessionGroupKey[] = ['pinned', 'today', 'yesterday', 'week', 'month', 'earlier']

/** 当天 0 点的时间戳 */
function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * 按「置顶 / 今天 / 昨天 / 7天内 / 30天内 / 更早」对会话分组。
 * 置顶会话独立成组,不再按时间细分(参考豆包/ChatGPT)。
 * 入参假定已按 pinned/lastActivity 排好序;空组不返回。
 * @param now 当前时间戳(默认 Date.now,测试可注入)
 */
export function groupSessions(sessions: ChatSession[], now: number = Date.now()): SessionGroup[] {
  const todayStart = startOfDay(now)
  const dayMs = 86_400_000
  const yesterdayStart = todayStart - dayMs
  const weekStart = todayStart - 6 * dayMs // 今天起往前 7 天(含今天)
  const monthStart = todayStart - 29 * dayMs // 30 天(含今天)

  const buckets: Record<SessionGroupKey, ChatSession[]> = {
    pinned: [],
    today: [],
    yesterday: [],
    week: [],
    month: [],
    earlier: []
  }

  for (const s of sessions) {
    if (s.pinned) {
      buckets.pinned.push(s)
      continue
    }
    const t = s.lastActivity
    if (t >= todayStart) buckets.today.push(s)
    else if (t >= yesterdayStart) buckets.yesterday.push(s)
    else if (t >= weekStart) buckets.week.push(s)
    else if (t >= monthStart) buckets.month.push(s)
    else buckets.earlier.push(s)
  }

  return GROUP_ORDER.filter((k) => buckets[k].length > 0).map((k) => ({
    key: k,
    label: GROUP_LABELS[k],
    sessions: buckets[k]
  }))
}
