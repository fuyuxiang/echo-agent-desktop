import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import { getDb } from '../db'
import {
  upsertMirror,
  listMirror,
  deleteMirrorByServerId,
  type MirrorRecord
} from '../db/dao/project-memory'
import { listCognitiveMemory } from '../echo-agent/cognitive-memory'
import { getEchoAgentEndpoint } from '../echo-agent'

export function registerProjectMemoryIpc(): void {
  ipcMain.handle(IpcChannels.projectMemory.listMirror, () => listMirror(getDb()))

  ipcMain.handle(IpcChannels.projectMemory.upsertMirror, (_e, row: MirrorRecord) => {
    upsertMirror(getDb(), row)
  })

  ipcMain.handle(IpcChannels.projectMemory.deleteMirror, (_e, serverId: string) => {
    deleteMirrorByServerId(getDb(), serverId)
  })

  ipcMain.handle(IpcChannels.echoMemory.list, async (_e, limit?: number) => {
    const endpoint = getEchoAgentEndpoint()
    if (!endpoint) return []
    return listCognitiveMemory(endpoint, limit)
  })
}
