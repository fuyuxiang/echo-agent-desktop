// src/main/agent/memory/consolidator.ts
import type { MemoryDao } from './dao'
import type { Reflector } from './reflector'
import type { Extractor } from './extractor'
import type { Linker } from './linker'
import type { MemoryLLM } from './llm'

interface ConsolidatorOpts {
  halfLifeDays?: number
  confFloor?: number
  idleDaysForDecay?: number
  batch?: number
}

const DAY_MS = 86_400_000

export class Consolidator {
  private lastConsolidateAt = 0
  private readonly halfLifeDays: number
  private readonly confFloor: number
  private readonly idleDaysForDecay: number
  private readonly batch: number

  constructor(
    private deps: {
      dao: MemoryDao
      reflector: Reflector
      extractor: Extractor
      linker: Linker
      llm: MemoryLLM
      opts?: ConsolidatorOpts
    }
  ) {
    this.halfLifeDays = deps.opts?.halfLifeDays ?? 30
    this.confFloor = deps.opts?.confFloor ?? 0.2
    this.idleDaysForDecay = deps.opts?.idleDaysForDecay ?? 7
    this.batch = deps.opts?.batch ?? 20
  }

  async run(): Promise<void> {
    const now = Date.now()
    await this.distill(now)
    this.decay(now)
    await this.evolveRecent(now)
    this.lastConsolidateAt = now
  }

  /** A. 提炼: 未整合 episode → reflect → decideAndApply 去重落库; 无论成败都 markConsolidated。 */
  private async distill(_now: number): Promise<void> {
    const eps = this.deps.dao.listUnconsolidated(this.batch)
    if (eps.length === 0) return
    try {
      const facts = await this.deps.reflector.reflect(eps)
      for (const f of facts) {
        await this.deps.extractor.decideAndApply(f.content, {
          sessionKey: eps[0]?.sessionKey ?? 'consolidate',
          messageIds: []
        })
      }
    } finally {
      this.deps.dao.markConsolidated(eps.map((e) => e.id))
    }
  }

  /** B. 衰减/demote: 纯本地零 LLM。 */
  private decay(now: number): void {
    const page = this.deps.dao.listSemantic(500, 0)
    for (const m of page) {
      const ts = m.lastAccess ?? m.createdAt
      const idleDays = (now - ts) / DAY_MS
      if (idleDays < this.idleDaysForDecay) continue
      const newConf = m.confidence * Math.exp((-Math.LN2 * idleDays) / this.halfLifeDays)
      this.deps.dao.setConfidence(m.id, newConf)
      if (newConf < this.confFloor && m.tier === 'semantic') {
        this.deps.dao.demote(m.id)
      }
    }
  }

  /** C. 演化: 仅对本周期新增(created_at > lastConsolidateAt)的记忆做邻居演化。 */
  private async evolveRecent(_now: number): Promise<void> {
    const recent = this.deps.dao
      .listSemantic(500, 0)
      .filter((m) => m.createdAt > this.lastConsolidateAt)
      .map((m) => m.id)
    if (recent.length > 0) await this.deps.linker.evolve(recent)
  }
}
