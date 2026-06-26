// src/main/agent/memory/types.ts
// 记忆领域类型(纯类型,无运行时代码)

/** 记忆主类型:用户偏好 / 环境信息 / 程序性知识 */
export type MemType = 'user' | 'environment' | 'procedural'

/** 记忆分层:语义/程序记忆 vs 归档(冷数据) */
export type MemTier = 'semantic' | 'procedural' | 'archival'

/** provenance 溯源 */
export interface Provenance {
  sessionKey: string
  messageIds: number[]
}

/** 语义/程序记忆主记录(对应 personal_memory 行) */
export interface MemoryRecord {
  id: number
  content: string
  memType: MemType
  tier: MemTier
  keywords: string[]
  tags: string[]
  contextDesc: string
  importance: number // 1-10
  confidence: number // 0-1
  salience: number | null
  provenance: Provenance | null
  accessCount: number
  lastAccess: number | null
  createdAt: number
  updatedAt: number
  supersededBy: number | null
}

/** 写入主记录的入参(id/时间戳由 DAO 生成) */
export interface MemoryInput {
  content: string
  memType: MemType
  tier: MemTier
  keywords?: string[]
  tags?: string[]
  contextDesc?: string
  importance: number
  confidence?: number // 默认 0.7
  salience?: number | null
  provenance?: Provenance | null
}

/** 情景记忆(对应 memory_episodes 行) */
export interface Episode {
  id: number
  content: string
  entities: string[]
  sessionKey: string
  messageRange: { fromId: number; toId: number } | null
  importance: number | null
  consolidated: boolean
  ts: number
}

/** 写入情景记忆的入参 */
export interface EpisodeInput {
  content: string
  entities?: string[]
  sessionKey: string
  messageRange?: { fromId: number; toId: number } | null
  importance?: number | null
}

/** Zettelkasten 链接 */
export interface MemoryLink {
  fromId: number
  toId: number
  relation: string
  weight: number
}

/** 检索命中(对外,= P2 MemoryHit 的超集,转换在 retriever 完成) */
export interface ScoredMemory {
  record: MemoryRecord
  relevance: number
  recency: number
  importanceScore: number
  score: number
}

/** Mem0 抽取决策 */
export type ExtractDecision =
  | { op: 'ADD'; content: string; memType: MemType; importance: number; keywords: string[]; tags: string[]; contextDesc: string }
  | { op: 'UPDATE'; targetId: number; content: string; importance: number }
  | { op: 'DELETE'; targetId: number }
  | { op: 'NOOP' }
