// src/main/agent/runtime/context-builder.ts
import type { ChatMessage } from '../providers'
import type { MessageRow } from '../../db/dao/session'
import type { MemoryGateway } from '../tools/memory-facade'
import type { SkillGateway } from '../tools/skill-facade'
import type { MemoryHit } from '../tools/memory-facade'

const DEFAULT_MAX_HISTORY_TURNS = 12

export interface BuildContextInput {
  chatId: string
  systemPrompt: string
  history: MessageRow[]
  userText: string
  memory: MemoryGateway
  skills: SkillGateway
  /** 已召回的 hits(由 AgentRuntime 提前调用,避免重复) */
  recalledHits?: MemoryHit[]
  maxHistoryTurns?: number
}

/** MessageRow -> provider ChatMessage */
function toChatMessage(r: MessageRow): ChatMessage {
  const m: ChatMessage = { role: r.role as ChatMessage['role'], content: r.content }
  if (r.toolCalls) m.toolCalls = r.toolCalls
  if (r.toolCallId) m.toolCallId = r.toolCallId
  if (r.toolName) m.name = r.toolName
  return m
}

/** 从尾部按完整轮(以 user 为边界)截取最近 N 轮,保证从 user 轮起始处开始 */
function sliceByTurns(history: MessageRow[], maxTurns: number): MessageRow[] {
  const userIndices: number[] = []
  for (let i = 0; i < history.length; i++) {
    if (history[i].role === 'user') userIndices.push(i)
  }
  if (userIndices.length <= maxTurns) return history
  return history.slice(userIndices[userIndices.length - maxTurns])
}

export async function buildContext(input: BuildContextInput): Promise<ChatMessage[]> {
  const maxTurns = input.maxHistoryTurns ?? DEFAULT_MAX_HISTORY_TURNS
  const hits = input.recalledHits ?? (await input.memory.recall(input.userText, input.chatId))
  const memoryBlock = hits.length ? `\n\n[相关记忆]\n${hits.map((h) => h.text).join('\n')}` : ''
  const skillBlock = input.skills.activePromptFragments(input.chatId).join('\n')
  const systemContent = [input.systemPrompt, skillBlock].filter(Boolean).join('\n\n') + memoryBlock

  const windowed = sliceByTurns(input.history, maxTurns)
  return [
    { role: 'system', content: systemContent },
    ...windowed.map(toChatMessage),
    { role: 'user', content: input.userText }
  ]
}
