// src/main/agent/memory/manager.ts
import type Database from 'better-sqlite3'
import { log } from '../../logger'
import type { ChatProvider, ChatMessage } from '../providers'
import type { MemoryGateway, MemoryHit } from '../tools/memory-facade'
import { MemoryDao } from './dao'
import { ProviderMemoryLLM } from './llm'
import { Retriever } from './retriever'
import { Encoder } from './encoder'
import { Extractor } from './extractor'
import { Linker } from './linker'
import { Reflector } from './reflector'
import { Consolidator } from './consolidator'
import { Metacognition, type MemoryStats } from './metacognition'
import type { MemoryRecord, MemoryInput, Provenance } from './types'

export interface MemoryManagerOpts {
  salienceThreshold?: number
  idleMs?: number
  checkMs?: number
  halfLifeDays?: number
}

const STARTUP_DELAY_MS = 30_000

export class MemoryManager implements MemoryGateway {
  private dao: MemoryDao
  private retriever: Retriever
  private encoder: Encoder
  private extractor: Extractor
  private linker: Linker
  private consolidator: Consolidator
  private meta: Metacognition
  private tail: Promise<void> = Promise.resolve()
  private lastInteractionAt = Date.now()
  private timer: ReturnType<typeof setInterval> | null = null
  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private readonly salienceThreshold: number
  private readonly idleMs: number

  constructor(deps: {
    db: Database.Database
    provider: ChatProvider
    model: string
    opts?: MemoryManagerOpts
  }) {
    const llm = new ProviderMemoryLLM({ provider: deps.provider, model: deps.model })
    this.dao = new MemoryDao(deps.db)
    this.retriever = new Retriever(this.dao)
    this.encoder = new Encoder(llm)
    this.extractor = new Extractor({ llm, dao: this.dao, retriever: this.retriever })
    this.linker = new Linker({ dao: this.dao, retriever: this.retriever, llm })
    const reflector = new Reflector(llm)
    this.consolidator = new Consolidator({
      dao: this.dao,
      reflector,
      extractor: this.extractor,
      linker: this.linker,
      llm,
      opts: { halfLifeDays: deps.opts?.halfLifeDays }
    })
    this.meta = new Metacognition({ db: deps.db, dao: this.dao })
    this.salienceThreshold = deps.opts?.salienceThreshold ?? 0.3
    this.idleMs = deps.opts?.idleMs ?? 3 * 60_000
    const checkMs = deps.opts?.checkMs ?? 5 * 60_000
    this.timer = setInterval(() => this.maybeConsolidate(), checkMs)
    this.startupTimer = setTimeout(() => this.enqueue(() => this.consolidator.run()), STARTUP_DELAY_MS)
  }

  private enqueue(task: () => Promise<void>): void {
    this.tail = this.tail.then(task).catch((e) => log.warn('[memory] task failed', e))
  }

  /** 测试用: 等待当前队列排空。 */
  async flush(): Promise<void> {
    await this.tail
  }

  recall(query: string, _chatId: string): Promise<MemoryHit[]> {
    const scored = this.retriever.retrieve(query)
    return Promise.resolve(
      scored.map((s) => ({ id: String(s.record.id), text: s.record.content, score: s.score }))
    )
  }

  capture(chatId: string, turn: ChatMessage[]): Promise<void> {
    this.lastInteractionAt = Date.now()
    this.enqueue(() => this.runCapture(chatId, turn))
    return Promise.resolve()
  }

  private async runCapture(chatId: string, turn: ChatMessage[]): Promise<void> {
    const userText = lastContent(turn, 'user')
    const assistantText = lastContent(turn, 'assistant')
    if (!userText && !assistantText) return
    const provenance: Provenance = { sessionKey: chatId, messageIds: [] }
    const salience = await this.encoder.salience({ userText, assistantText })
    this.dao.insertEpisode({
      content: `用户: ${userText}\n助手: ${assistantText}`.trim(),
      sessionKey: chatId
    })
    if (salience < this.salienceThreshold) return
    const ids = await this.extractor.extract({ userText, assistantText, provenance })
    for (const id of ids) this.linker.link(id)
  }

  private maybeConsolidate(): void {
    if (Date.now() - this.lastInteractionAt < this.idleMs) return
    if (this.dao.listUnconsolidated(1).length === 0) return
    this.enqueue(() => this.consolidator.run())
  }

  // --- 供 IPC 的只读/手动操作转发 ---
  list(limit: number, offset: number): MemoryRecord[] {
    return this.dao.listSemantic(limit, offset)
  }
  search(query: string, topK: number): MemoryRecord[] {
    return this.retriever.retrieve(query, { topK }).map((s) => s.record)
  }
  get(id: number): MemoryRecord | undefined {
    return this.dao.getMemory(id)
  }
  getProvenance(id: number): Provenance | null {
    return this.meta.provenanceOf(id)
  }
  update(id: number, patch: Partial<MemoryInput>): void {
    this.dao.updateMemory(id, patch)
  }
  remove(id: number): void {
    this.dao.softDelete(id)
  }
  stats(): MemoryStats {
    return this.meta.stats()
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.timer = null
    this.startupTimer = null
  }
}

function lastContent(turn: ChatMessage[], role: 'user' | 'assistant'): string {
  for (let i = turn.length - 1; i >= 0; i--) {
    if (turn[i].role === role) return turn[i].content ?? ''
  }
  return ''
}
