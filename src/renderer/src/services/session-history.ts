/**
 * Pure helpers for session history: staleness detection and fallback replay material extraction.
 *
 * The server persists conversation context keyed by session_key with a 72h TTL. The client has no
 * probe endpoint, so it conservatively relies on a local lastActivity timestamp (48h): once the
 * threshold is exceeded the server context is treated as possibly expired, and when reopening the
 * session the most recent N rounds are concatenated into a "history recap" and fed back to rebuild context.
 */

/** Staleness threshold: server TTL is 72h, use a conservative 48h for safety margin */
export const SESSION_STALE_MS = 48 * 60 * 60 * 1000

/** Number of fallback replay rounds (one round = one user+assistant exchange) */
export const REPLAY_ROUNDS = 6

/** Minimal message shape used as replay material */
export interface PrimerMessage {
  role: 'user' | 'assistant'
  content: string
}

/** Whether the time since the last activity exceeds the staleness threshold */
export function isSessionStale(lastActivity: number, now: number = Date.now()): boolean {
  return now - lastActivity > SESSION_STALE_MS
}

/** Take the most recent `rounds` of user/assistant messages (filtering out system), preserving order */
export function extractRecentRounds(
  messages: PrimerMessage[],
  rounds: number = REPLAY_ROUNDS
): PrimerMessage[] {
  const dialog = messages.filter((m) => m.role === 'user' || m.role === 'assistant')
  // One round is roughly two messages; take the last rounds*2 as an approximation (enough to cover continued chats)
  return dialog.slice(-rounds * 2)
}

/** Concatenate the most recent rounds into a "history recap" context text; returns empty string when empty */
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
