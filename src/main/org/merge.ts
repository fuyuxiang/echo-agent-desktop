/**
 * L1/L2/L3 合并检索。
 *
 * 输入:
 *   - local: 个人记忆 L1(本地 personal_memory_fts) 命中;
 *   - org:   组织检索 L2/L3(server /retrieve) 命中。
 *
 * 合并策略:Reciprocal Rank Fusion,常数 k=60。
 *   score = Σ_i 1/(60 + rank_i)
 *
 * 每条结果打上 source 标记:
 *   - 'L1'    个人记忆
 *   - 'L2'    团队文档
 *   - 'L3'    组织文档
 * 供 UI 在 citation 旁标注层级。
 */

import type { RetrievedChunk } from '@shared/types/org'

export type KnowledgeLayer = 'L1' | 'L2' | 'L3'

export interface MergedChunk {
  source: KnowledgeLayer
  text: string
  title: string
  docId?: string
  chunkId?: string
  score: number
  citation?: { page: number | null; heading: string; startMs: number | null }
  // 个人记忆可选:salience 用于 UI 排序提示。
  salience?: number
}

const K = 60

export function mergeKnowledgeSources(opts: {
  local?: Array<{ id: number; content: string; title?: string; salience?: number }>
  org?: {
    chunks: RetrievedChunk[]
    memories: Array<{ id: string; content: string }>
  }
  limit?: number
}): MergedChunk[] {
  const limit = opts.limit ?? 8
  const byKey = new Map<string, MergedChunk>()

  // L1:个人记忆。
  opts.local?.forEach((m, idx) => {
    const key = `L1:${m.id}`
    const contribution = 1 / (K + idx + 1)
    byKey.set(key, {
      source: 'L1',
      text: m.content,
      title: m.title ?? '个人记忆',
      chunkId: `local-${m.id}`,
      score: contribution,
      salience: m.salience
    })
  })

  // L2/L3:组织检索结果。
  opts.org?.chunks.forEach((c, idx) => {
    const key = `org-chunk:${c.chunkId}`
    const contribution = 1 / (K + idx + 1)
    byKey.set(key, {
      source: c.scopeKind === 'team' ? 'L2' : 'L3',
      text: c.text,
      title: c.docTitle,
      docId: c.docId,
      chunkId: c.chunkId,
      score: contribution,
      citation: c.citation
    })
  })

  // org_memories 也作为 L3 知识纳入。
  opts.org?.memories.forEach((m, idx) => {
    const key = `org-mem:${m.id}`
    const contribution = 1 / (K + idx + 1) * 0.8 // 记忆略低于 chunk 优先级
    const existing = byKey.get(key)
    if (existing) {
      existing.score += contribution
    } else {
      byKey.set(key, {
        source: 'L3',
        text: m.content,
        title: '组织记忆',
        docId: m.id,
        chunkId: `org-mem-${m.id}`,
        score: contribution
      })
    }
  })

  return [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, limit)
}
