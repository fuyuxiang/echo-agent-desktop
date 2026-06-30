import { describe, it, expect, vi, beforeEach } from 'vitest'

const { handlers, dao, listCognitiveMemory, getEchoAgentEndpoint } = vi.hoisted(() => {
  const handlers = new Map<string, (...a: unknown[]) => unknown>()
  const dao = {
    upsertMirror: vi.fn(),
    listMirror: vi.fn(() => [{ serverId: 's1' }]),
    deleteMirrorByServerId: vi.fn()
  }
  const listCognitiveMemory = vi.fn(
    async (..._a: unknown[]) => [{ id: 'm1', content: 'c', tags: ['project'], importance: 0.5 }]
  )
  const getEchoAgentEndpoint = vi.fn<() => { baseUrl: string; token: string } | null>(() => ({
    baseUrl: 'http://x',
    token: 't'
  }))
  return { handlers, dao, listCognitiveMemory, getEchoAgentEndpoint }
})

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) }
}))
vi.mock('../../db/dao/project-memory', () => dao)
vi.mock('../../db', () => ({ getDb: () => ({ __db: true }) }))
vi.mock('../../echo-agent/cognitive-memory', () => ({
  listCognitiveMemory: (...a: unknown[]) => listCognitiveMemory(...a)
}))
vi.mock('../../echo-agent', () => ({ getEchoAgentEndpoint: () => getEchoAgentEndpoint() }))

import { registerProjectMemoryIpc } from '../project-memory'
import { IpcChannels } from '@shared/ipc-channels'

describe('project-memory ipc', () => {
  beforeEach(() => { handlers.clear(); vi.clearAllMocks() })

  it('listMirror delegates to dao', () => {
    registerProjectMemoryIpc()
    expect(handlers.get(IpcChannels.projectMemory.listMirror)!()).toEqual([{ serverId: 's1' }])
  })
  it('upsertMirror delegates row to dao', () => {
    registerProjectMemoryIpc()
    const row = { serverId: 's1', content: 'c', tags: ['a'], version: 1, updatedAt: 1 }
    handlers.get(IpcChannels.projectMemory.upsertMirror)!({}, row)
    expect(dao.upsertMirror).toHaveBeenCalledWith({ __db: true }, row)
  })
  it('echoMemory.list returns entries when endpoint ready', async () => {
    registerProjectMemoryIpc()
    const r = await handlers.get(IpcChannels.echoMemory.list)!({}, 50)
    expect(r).toEqual([{ id: 'm1', content: 'c', tags: ['project'], importance: 0.5 }])
  })
  it('echoMemory.list returns [] when endpoint not ready', async () => {
    getEchoAgentEndpoint.mockReturnValueOnce(null)
    registerProjectMemoryIpc()
    const r = await handlers.get(IpcChannels.echoMemory.list)!({}, 50)
    expect(r).toEqual([])
    expect(listCognitiveMemory).not.toHaveBeenCalled()
  })
})
