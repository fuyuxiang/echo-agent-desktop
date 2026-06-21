import { memoryAPI, type MemoryEntry } from './agent/memory'

/** 个人记忆(本地 echo-agent 维护,存于用户本机) */
export interface PersonalMemory {
  id: string
  type: string
  tier: string
  key: string
  content: string
  tags: string[]
  importance: number
  sourceSession: string
  createdAt: string
  updatedAt: string
}

/** 把 echo-agent 的 MemoryEntry(snake_case)映射为对外的 PersonalMemory(camelCase) */
export function toPersonalMemory(entry: MemoryEntry): PersonalMemory {
  return {
    id: entry.id,
    type: entry.type,
    tier: entry.tier,
    key: entry.key ?? '',
    content: entry.content,
    tags: entry.tags ?? [],
    importance: entry.importance ?? 0,
    sourceSession: entry.source_session ?? '',
    createdAt: entry.created_at ?? '',
    updatedAt: entry.updated_at ?? ''
  }
}

/** 列出全部个人记忆 */
export function listPersonalMemory(): Promise<PersonalMemory[]> {
  return memoryAPI.list().then((r) => r.entries.map(toPersonalMemory))
}

/** 语义检索个人记忆 */
export function searchPersonalMemory(query: string): Promise<PersonalMemory[]> {
  return memoryAPI.search(query).then((r) => r.results.map((x) => toPersonalMemory(x.entry)))
}

/** 删除一条个人记忆 */
export function deletePersonalMemory(id: string): Promise<void> {
  return memoryAPI.delete(id).then(() => {})
}
