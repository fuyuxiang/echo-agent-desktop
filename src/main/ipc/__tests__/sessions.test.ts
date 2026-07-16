import { describe, it, expect, vi, beforeEach } from 'vitest'

const { handlers, sessionService } = vi.hoisted(() => {
  const handlers = new Map<string, (...a: unknown[]) => unknown>()
  const sessionService = {
    listSessions: vi.fn(async () => ({
      sessions: [],
      total: 0,
      groupedByDate: { today: [], yesterday: [], thisWeek: [], older: [] }
    })),
    getSession: vi.fn(async (_id: string) => null),
    updateSession: vi.fn(async (req: unknown) => ({ id: 'u-id', ...(req as object) })),
    deleteSession: vi.fn(async (_id: string) => undefined),
    searchSessions: vi.fn(async () => ({ results: [], total: 0, query: '' })),
    exportSession: vi.fn(async (_id: string) => ({
      session: { id: 's1', title: 't', createdAt: '', updatedAt: '', messageCount: 0, isActive: true },
      messages: [],
      exportedAt: '',
      version: '1.0.0'
    })),
    importSession: vi.fn(async (data: unknown) => ({
      id: 'imported-id',
      title: 'imported',
      createdAt: '',
      updatedAt: '',
      messageCount: 0,
      isActive: true,
      ...((data as Record<string, unknown>)?.session ?? {})
    }))
  }
  return { handlers, sessionService }
})

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) }
}))
vi.mock('../../sessions', () => sessionService)

import { registerSessionIpcHandlers } from '../sessions'
import { IpcChannels } from '@shared/ipc-channels'

describe('session IPC handlers', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    registerSessionIpcHandlers()
  })

  function invoke(ch: string, ...args: unknown[]): unknown {
    return handlers.get(ch)!({}, ...args)
  }

  it('registers all seven session channels', () => {
    const expected = [
      IpcChannels.sessions.list,
      IpcChannels.sessions.get,
      IpcChannels.sessions.update,
      IpcChannels.sessions.delete,
      IpcChannels.sessions.search,
      IpcChannels.sessions.export,
      IpcChannels.sessions.import
    ]
    for (const ch of expected) {
      expect(handlers.has(ch), `missing handler for ${ch}`).toBe(true)
    }
  })

  it('sessions:list delegates to listSessions', async () => {
    const fakeResponse = {
      sessions: [{ id: 's1', title: 'Test' }],
      total: 1,
      groupedByDate: { today: [{ id: 's1', title: 'Test' }], yesterday: [], thisWeek: [], older: [] }
    }
    sessionService.listSessions.mockResolvedValueOnce(fakeResponse as any)
    const result = await invoke(IpcChannels.sessions.list)
    expect(sessionService.listSessions).toHaveBeenCalled()
    expect(result).toEqual(fakeResponse)
  })

  it('sessions:get passes id to getSession', async () => {
    const fakeSession = { id: 's1', title: 'Test Session' }
    sessionService.getSession.mockResolvedValueOnce(fakeSession as any)
    const result = await invoke(IpcChannels.sessions.get, 's1')
    expect(sessionService.getSession).toHaveBeenCalledWith('s1')
    expect(result).toEqual(fakeSession)
  })

  it('sessions:update passes request to updateSession', async () => {
    const req = { id: 's1', title: 'Updated Title' }
    const updated = { id: 's1', title: 'Updated Title', updatedAt: '2024-01-01' }
    sessionService.updateSession.mockResolvedValueOnce(updated)
    const result = await invoke(IpcChannels.sessions.update, req)
    expect(sessionService.updateSession).toHaveBeenCalledWith(req)
    expect(result).toEqual(updated)
  })

  it('sessions:delete passes id to deleteSession', async () => {
    await invoke(IpcChannels.sessions.delete, 's1')
    expect(sessionService.deleteSession).toHaveBeenCalledWith('s1')
  })

  it('sessions:search passes request to searchSessions', async () => {
    const req = { query: 'python', limit: 10 }
    const response = { results: [{ id: 's1', title: 'Python Tutorial' }], total: 1, query: 'python' }
    sessionService.searchSessions.mockResolvedValueOnce(response as any)
    const result = await invoke(IpcChannels.sessions.search, req)
    expect(sessionService.searchSessions).toHaveBeenCalledWith(req)
    expect(result).toEqual(response)
  })

  it('sessions:export passes id to exportSession', async () => {
    const exportData = {
      session: { id: 's1', title: 'Test' },
      messages: [],
      exportedAt: '2024-01-01',
      version: '1.0.0'
    }
    sessionService.exportSession.mockResolvedValueOnce(exportData as any)
    const result = await invoke(IpcChannels.sessions.export, 's1')
    expect(sessionService.exportSession).toHaveBeenCalledWith('s1')
    expect(result).toEqual(exportData)
  })

  it('sessions:import passes data to importSession', async () => {
    const importData = {
      session: { id: 'old-id', title: 'Imported', createdAt: '', updatedAt: '', messageCount: 0, isActive: true },
      messages: []
    }
    const imported = { id: 'new-id', title: 'Imported', createdAt: '', updatedAt: '', messageCount: 0, isActive: true }
    sessionService.importSession.mockResolvedValueOnce(imported)
    const result = await invoke(IpcChannels.sessions.import, importData)
    expect(sessionService.importSession).toHaveBeenCalledWith(importData)
    expect(result).toEqual(imported)
  })
})
