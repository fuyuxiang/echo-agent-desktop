// src/main/agent/memory/reflector.ts
import type { MemoryLLM } from './llm'
import { parseJsonLoose } from './llm'
import type { Episode, MemType } from './types'

export interface ReflectedFact {
  content: string
  memType: MemType
  importance: number
  keywords: string[]
  tags: string[]
}

const VALID_TYPES: MemType[] = ['user', 'environment', 'procedural']

export class Reflector {
  constructor(private llm: MemoryLLM) {}

  async reflect(episodes: Episode[]): Promise<ReflectedFact[]> {
    if (episodes.length === 0) return []
    const material = episodes.map((e, i) => `(${i + 1}) ${e.content}`).join('\n')
    const raw = await this.llm.complete(
      `下面是若干对话片段。归纳出值得长期记住的高层用户事实或模式,每条独立。\n` +
        `只输出 JSON: {"facts":[{"content":"","memType":"user|environment|procedural","importance":1-10,"keywords":[],"tags":[]}]}\n\n${material}`
    )
    const parsed = parseJsonLoose<{ facts: ReflectedFact[] }>(raw)
    if (!parsed?.facts) return []
    return parsed.facts.filter(
      (f) =>
        f &&
        typeof f.content === 'string' &&
        f.content.trim() !== '' &&
        VALID_TYPES.includes(f.memType) &&
        typeof f.importance === 'number'
    ).map((f) => ({
      content: f.content,
      memType: f.memType,
      importance: f.importance,
      keywords: Array.isArray(f.keywords) ? f.keywords : [],
      tags: Array.isArray(f.tags) ? f.tags : []
    }))
  }
}
