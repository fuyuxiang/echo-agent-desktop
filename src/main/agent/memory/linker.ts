// src/main/agent/memory/linker.ts
import type { MemoryDao } from './dao'
import type { Retriever } from './retriever'
import type { MemoryLLM } from './llm'
import { parseJsonLoose } from './llm'

const MAX_LINKS = 3
const LINK_MIN = 0.2
const SIMILAR_TOPK = 5

export class Linker {
  constructor(private deps: { dao: MemoryDao; retriever: Retriever; llm: MemoryLLM }) {}

  /** 同步建链: 为新记忆找相似旧记忆,启发式判 relation/weight,零 LLM。 */
  link(newId: number): void {
    const rec = this.deps.dao.getMemory(newId)
    if (!rec || rec.supersededBy !== null) return
    const similar = this.deps.retriever.retrieve(rec.content, {
      topK: SIMILAR_TOPK,
      expandLinks: false
    })
    let built = 0
    for (const s of similar) {
      if (built >= MAX_LINKS) break
      const other = s.record
      if (other.id === newId || other.supersededBy !== null) continue
      const { relation, weight } = this.judge(rec, other, s.score)
      if (weight < LINK_MIN) continue
      this.deps.dao.addLink({ fromId: newId, toId: other.id, relation, weight })
      built++
    }
  }

  /** 启发式: tags/keywords 交集 → related(交集占比); 否则 similar(检索分)。 */
  private judge(
    a: { tags: string[]; keywords: string[] },
    b: { tags: string[]; keywords: string[] },
    score: number
  ): { relation: string; weight: number } {
    const setA = new Set([...a.tags, ...a.keywords])
    const setB = new Set([...b.tags, ...b.keywords])
    const inter = [...setA].filter((x) => setB.has(x))
    const union = new Set([...setA, ...setB])
    if (inter.length > 0 && union.size > 0) {
      return { relation: 'related', weight: Math.min(1, inter.length / union.size) }
    }
    return { relation: 'similar', weight: Math.max(0, Math.min(1, score)) }
  }

  /** 异步演化: 对 seed 记忆的一跳邻居,LLM 判断是否更新 contextDesc/tags(只改元数据)。 */
  async evolve(seedIds: number[]): Promise<void> {
    const neighborIds = new Set<number>()
    for (const id of seedIds) {
      for (const link of this.deps.dao.linksOf(id)) {
        const other = link.fromId === id ? link.toId : link.fromId
        if (!seedIds.includes(other)) neighborIds.add(other)
      }
    }
    for (const nbId of neighborIds) {
      const nb = this.deps.dao.getMemory(nbId)
      if (!nb || nb.supersededBy !== null) continue
      const raw = await this.deps.llm.complete(
        `已有记忆: ${nb.content}\n当前描述: ${nb.contextDesc}\n标签: ${JSON.stringify(nb.tags)}\n` +
          `近期出现了相关新记忆。判断是否需要更新这条记忆的描述或标签(不改正文)。\n` +
          `只输出 JSON: {"update":bool,"contextDesc"?:string,"tags"?:string[]}`
      )
      const dec = parseJsonLoose<{ update: boolean; contextDesc?: string; tags?: string[] }>(raw)
      if (!dec || !dec.update) continue
      this.deps.dao.updateMemory(nbId, {
        contextDesc: dec.contextDesc ?? nb.contextDesc,
        tags: dec.tags ?? nb.tags
      })
    }
  }
}
