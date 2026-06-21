/**
 * 会话历史相关纯函数:失效判定与兜底重发素材提取
 *
 * 服务端按 session_key 持久化对话上下文,TTL 72h。客户端无探测接口,
 * 改用本地 lastActivity 时间戳保守判定(48h):超阈值视为服务端可能已失效,
 * 重开会话时把最近 N 轮原文拼成"历史回顾"喂回去重建上下文。
 */

/** 失效阈值:服务端 TTL 72h,取保守值 48h 留安全余量 */
export const SESSION_STALE_MS = 48 * 60 * 60 * 1000

/** 兜底重发轮数(一轮 = 一次 user+assistant 往返) */
export const REPLAY_ROUNDS = 6

/** 重发素材的最小消息形状 */
export interface PrimerMessage {
  role: 'user' | 'assistant'
  content: string
}

/** 距上次活动是否已超过失效阈值 */
export function isSessionStale(lastActivity: number, now: number = Date.now()): boolean {
  return now - lastActivity > SESSION_STALE_MS
}

/** 取最近 rounds 轮的 user/assistant 原文(过滤 system),保持时间顺序 */
export function extractRecentRounds(
  messages: PrimerMessage[],
  rounds: number = REPLAY_ROUNDS
): PrimerMessage[] {
  const dialog = messages.filter((m) => m.role === 'user' || m.role === 'assistant')
  // 一轮约两条消息,取最近 rounds*2 条作近似(足够覆盖续聊场景)
  return dialog.slice(-rounds * 2)
}

/** 把最近若干轮拼成"历史回顾"上下文文本;空则返回空串 */
export function buildPrimerText(rounds: PrimerMessage[]): string {
  if (rounds.length === 0) return ''
  const lines = rounds.map((m) => {
    const speaker = m.role === 'user' ? '用户' : '助手'
    return `${speaker}：${m.content}`
  })
  return [
    '以下是此前对话的历史回顾(仅供你恢复上下文,不是新任务,无需重复回答):',
    '',
    ...lines,
    '',
    '请基于以上上下文,继续后续对话。'
  ].join('\n')
}
