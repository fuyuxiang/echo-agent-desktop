import { mergeProjectMemory, type MirrorRow } from './merge'
import { selectShareableMemories, type CognitiveEntry } from './filter'
import type { ProjectMemory } from '@/services/server'

export interface SyncDeps {
  listCognitiveMemory: () => Promise<CognitiveEntry[]>
  listServerProjectMemory: () => Promise<ProjectMemory[]>
  writeServerProjectMemory: (content: string, tags: string[]) => Promise<unknown>
  listMirror: () => Promise<MirrorRow[]>
  upsertMirror: (row: MirrorRow) => Promise<void>
  deleteMirror: (serverId: string) => Promise<void>
  alreadyShared: (content: string) => boolean
  markShared: (content: string) => void
}

export async function tickUpload(deps: SyncDeps): Promise<number> {
  const entries = await deps.listCognitiveMemory()
  const candidates = selectShareableMemories(entries)
  let uploaded = 0
  for (const c of candidates) {
    if (deps.alreadyShared(c.content)) continue
    await deps.writeServerProjectMemory(c.content, c.tags)
    deps.markShared(c.content)
    uploaded++
  }
  return uploaded
}

export async function tickDownload(deps: SyncDeps): Promise<{ upserted: number; deleted: number }> {
  const [server, local] = await Promise.all([deps.listServerProjectMemory(), deps.listMirror()])
  const { upserts, deletes } = mergeProjectMemory(local, server)
  for (const row of upserts) await deps.upsertMirror(row)
  for (const id of deletes) await deps.deleteMirror(id)
  return { upserted: upserts.length, deleted: deletes.length }
}
