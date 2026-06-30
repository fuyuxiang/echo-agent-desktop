import { tickUpload, tickDownload, type SyncDeps } from './sync-worker'
import { buildProjectMemoryContext } from './context'
import type { MirrorRow } from './merge'
import { searchProjectMemory, listProjectMemory, writeProjectMemory } from '@/services/server'

const sharedContents = new Set<string>()

export function buildSyncDeps(): SyncDeps {
  return {
    listCognitiveMemory: () => window.api.echoMemory.list(200),
    listServerProjectMemory: () => listProjectMemory(500, 0),
    writeServerProjectMemory: (content, tags) => writeProjectMemory(content, tags),
    listMirror: () => window.api.projectMemory.listMirror() as Promise<MirrorRow[]>,
    upsertMirror: (row) => window.api.projectMemory.upsertMirror(row),
    deleteMirror: (serverId) => window.api.projectMemory.deleteMirror(serverId),
    alreadyShared: (content) => sharedContents.has(content),
    markShared: (content) => sharedContents.add(content)
  }
}

let timer: ReturnType<typeof setInterval> | null = null

export function startProjectMemorySync(intervalMs = 5 * 60 * 1000): void {
  stopProjectMemorySync()
  const run = async (): Promise<void> => {
    const deps = buildSyncDeps()
    try {
      await tickDownload(deps)
      await tickUpload(deps)
    } catch {
      // best-effort: 网络/未就绪等暂时性失败,下个 tick 重试
    }
  }
  void run()
  timer = setInterval(() => void run(), intervalMs)
}

export function stopProjectMemorySync(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

export async function retrieveForMessage(userText: string): Promise<string> {
  try {
    const hits = await searchProjectMemory(userText, 5)
    return buildProjectMemoryContext(hits, userText)
  } catch {
    return userText
  }
}
