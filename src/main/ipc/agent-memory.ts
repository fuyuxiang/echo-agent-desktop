// src/main/ipc/agent-memory.ts
import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import { getMemoryManager } from '../agent/memory/singleton'
import type { MemoryStats } from '../agent/memory/metacognition'

const EMPTY_STATS: MemoryStats = {
  total: 0,
  byTier: { semantic: 0, procedural: 0, archival: 0 },
  byType: { user: 0, environment: 0, procedural: 0 },
  avgConfidence: 0,
  linkCount: 0,
  episodeCount: 0,
  unconsolidatedCount: 0
}

/** 注册 agent:memory:* handler。门面未初始化时优雅降级。 */
export function registerAgentMemoryIpc(): void {
  ipcMain.handle(IpcChannels.agentMemory.list, (_e, opts: { limit: number; offset: number }) => {
    const m = getMemoryManager()
    return m ? m.list(opts.limit, opts.offset) : []
  })

  ipcMain.handle(IpcChannels.agentMemory.search, (_e, opts: { query: string; topK?: number }) => {
    const m = getMemoryManager()
    return m ? m.search(opts.query, opts.topK ?? 8) : []
  })

  ipcMain.handle(IpcChannels.agentMemory.get, (_e, opts: { id: number }) => {
    const m = getMemoryManager()
    if (!m) return null
    const record = m.get(opts.id)
    return record ? { record, provenance: m.getProvenance(opts.id) } : null
  })

  ipcMain.handle(
    IpcChannels.agentMemory.update,
    (_e, opts: { id: number; patch: { content?: string; importance?: number; keywords?: string[]; tags?: string[]; contextDesc?: string } }) => {
      getMemoryManager()?.update(opts.id, opts.patch)
      return { success: true }
    }
  )

  ipcMain.handle(IpcChannels.agentMemory.delete, (_e, opts: { id: number }) => {
    getMemoryManager()?.remove(opts.id)
    return { success: true }
  })

  ipcMain.handle(IpcChannels.agentMemory.stats, () => {
    return getMemoryManager()?.stats() ?? EMPTY_STATS
  })
}
