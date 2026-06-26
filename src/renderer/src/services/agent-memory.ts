// src/renderer/src/services/agent-memory.ts
// P6 sweep: 适配新 MemoryEntry(camelCase + id: number)
import { memoryAPI, type MemoryEntry } from './agent/memory'

/** 对外暴露: id 仍以 string 表示(对外无感),字段对齐 P3 真实 MemoryRecord */
export interface PersonalMemory {
  id: string
  content: string
  memType: string
  tier: string
  keywords: string[]
  tags: string[]
  contextDesc: string
  importance: number
  confidence: number
  salience: number | null
  createdAt: number
  updatedAt: number
}

export function toPersonalMemory(entry: MemoryEntry): PersonalMemory {
  return {
    id: String(entry.id),
    content: entry.content,
    memType: entry.memType,
    tier: entry.tier,
    keywords: entry.keywords,
    tags: entry.tags,
    contextDesc: entry.contextDesc,
    importance: entry.importance,
    confidence: entry.confidence,
    salience: entry.salience,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt
  }
}

export function listPersonalMemory(): Promise<PersonalMemory[]> {
  return memoryAPI.list().then((r) => r.entries.map(toPersonalMemory))
}

export function searchPersonalMemory(query: string): Promise<PersonalMemory[]> {
  return memoryAPI.search(query).then((r) => r.results.map((x) => toPersonalMemory(x.entry)))
}

export function deletePersonalMemory(id: string): Promise<void> {
  return memoryAPI.delete(Number(id)).then(() => {})
}
