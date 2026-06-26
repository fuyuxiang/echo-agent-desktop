// src/main/agent/memory/singleton.ts
import { getDb } from '../../db'
import { MemoryManager, type MemoryManagerOpts } from './manager'
import type { ChatProvider } from '../providers'

let instance: MemoryManager | null = null

/** app 启动且 provider 配置就绪后调用一次。重复调用替换实例。 */
export function initMemoryManager(deps: {
  provider: ChatProvider
  model: string
  opts?: MemoryManagerOpts
}): MemoryManager {
  instance?.dispose()
  instance = new MemoryManager({
    db: getDb(),
    provider: deps.provider,
    model: deps.model,
    opts: deps.opts
  })
  return instance
}

/** 未初始化时返回 null,调用方降级(recall 空 / capture no-op)。 */
export function getMemoryManager(): MemoryManager | null {
  return instance
}

export function resetMemoryManagerForTest(m?: MemoryManager | null): void {
  instance?.dispose()
  instance = m ?? null
}
