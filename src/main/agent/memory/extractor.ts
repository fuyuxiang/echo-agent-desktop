// src/main/agent/memory/extractor.ts
import type { MemoryLLM } from './llm'
import { parseJsonLoose } from './llm'
import type { MemoryDao } from './dao'
import type { Retriever } from './retriever'
import type { ExtractDecision, Provenance } from './types'

export interface ExtractInput {
  userText: string
  assistantText: string
  provenance: Provenance
}

export class Extractor {
  constructor(private deps: { llm: MemoryLLM; dao: MemoryDao; retriever: Retriever }) {}

  async extract(input: ExtractInput): Promise<number[]> {
    const factsRaw = await this.deps.llm.complete(
      `从下面对话抽取值得长期记住的用户事实/偏好,每条一句话。\n` +
        `只输出 JSON: {"facts": string[]}\n\n用户: ${input.userText}\n助手: ${input.assistantText}`
    )
    const facts = parseJsonLoose<{ facts: string[] }>(factsRaw)?.facts
    if (!facts || facts.length === 0) return []
    const written: number[] = []
    for (const fact of facts) {
      const id = await this.decideAndApply(fact, input.provenance)
      if (id) written.push(id)
    }
    return written
  }

  /** 对单条事实: 检索相似 → LLM 决策 ADD/UPDATE/DELETE/NOOP → 落库。返回新记忆 id 或 null。 */
  async decideAndApply(fact: string, provenance: Provenance): Promise<number | null> {
    const similar = this.deps.retriever.retrieve(fact, { topK: 3, expandLinks: false })
    const similarText = similar
      .map((s) => `[id=${s.record.id}] ${s.record.content}`)
      .join('\n') || '(无)'
    const decRaw = await this.deps.llm.complete(
      `新事实: ${fact}\n已有相似记忆:\n${similarText}\n\n` +
        `判断如何处理,只输出 JSON,op 取 ADD/UPDATE/DELETE/NOOP:\n` +
        `ADD: {"op":"ADD","content":"","memType":"user|environment|procedural","importance":1-10,"keywords":[],"tags":[],"contextDesc":""}\n` +
        `UPDATE: {"op":"UPDATE","targetId":数字,"content":"","importance":1-10}\n` +
        `DELETE: {"op":"DELETE","targetId":数字}\nNOOP: {"op":"NOOP"}`
    )
    const dec = parseJsonLoose<ExtractDecision>(decRaw)
    if (!dec) return null
    return this.apply(dec, provenance)
  }

  private apply(dec: ExtractDecision, provenance: Provenance): number | null {
    if (dec.op === 'ADD') {
      return this.deps.dao.insertMemory({
        content: dec.content,
        memType: dec.memType,
        tier: 'semantic',
        importance: dec.importance,
        keywords: dec.keywords,
        tags: dec.tags,
        contextDesc: dec.contextDesc,
        provenance
      }).id
    }
    if (dec.op === 'UPDATE') {
      const old = this.deps.dao.getMemory(dec.targetId)
      if (!old) return null
      const newId = this.deps.dao.insertMemory({
        content: dec.content,
        memType: old.memType,
        tier: 'semantic',
        importance: dec.importance,
        keywords: old.keywords,
        tags: old.tags,
        contextDesc: old.contextDesc,
        provenance
      }).id
      this.deps.dao.supersede(dec.targetId, newId)
      return newId
    }
    if (dec.op === 'DELETE') {
      this.deps.dao.softDelete(dec.targetId)
      return null
    }
    return null // NOOP
  }
}