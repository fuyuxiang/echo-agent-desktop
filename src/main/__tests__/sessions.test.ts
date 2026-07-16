import { beforeEach, describe, expect, it, vi } from 'vitest'

const storeMock = vi.hoisted(() => {
  const data = new Map<string, unknown>()
  return {
    data,
    storeGet: vi.fn((key: string) => data.get(key)),
    storeSet: vi.fn((key: string, value: unknown) => { data.set(key, value) })
  }
})

vi.mock('../store', () => ({
  storeGet: storeMock.storeGet,
  storeSet: storeMock.storeSet
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  storeMock.data.clear()
})

describe('Session Management Service', () => {
  it('should list sessions with empty result', async () => {
    const { listSessions } = await import('../sessions')
    const result = await listSessions()
    expect(result).toBeDefined()
    expect(Array.isArray(result.sessions)).toBe(true)
    expect(result.sessions).toHaveLength(0)
    expect(result.total).toBe(0)
    expect(result.groupedByDate).toBeDefined()
    expect(result.groupedByDate.today).toEqual([])
    expect(result.groupedByDate.yesterday).toEqual([])
    expect(result.groupedByDate.thisWeek).toEqual([])
    expect(result.groupedByDate.older).toEqual([])
  })

  it('should create a session', async () => {
    const { createSession, listSessions } = await import('../sessions')
    const session = await createSession({ title: 'Test Session' })
    expect(session).toBeDefined()
    expect(session.id).toBeDefined()
    expect(session.title).toBe('Test Session')
    expect(session.isActive).toBe(true)
    expect(session.messageCount).toBe(0)
    expect(session.createdAt).toBeDefined()
    expect(session.updatedAt).toBeDefined()

    const list = await listSessions()
    expect(list.total).toBe(1)
    expect(list.sessions[0].id).toBe(session.id)
  })

  it('should get a session by id', async () => {
    const { createSession, getSession } = await import('../sessions')
    const session = await createSession({ title: 'My Session' })

    const found = await getSession(session.id)
    expect(found).toBeDefined()
    expect(found?.id).toBe(session.id)
    expect(found?.title).toBe('My Session')
  })

  it('should return null for non-existent session', async () => {
    const { getSession } = await import('../sessions')
    const found = await getSession('non-existent-id')
    expect(found).toBeNull()
  })

  it('should update a session title', async () => {
    const { createSession, updateSession } = await import('../sessions')
    const session = await createSession({ title: 'Original Title' })

    const updated = await updateSession({
      id: session.id,
      title: 'Updated Title'
    })
    expect(updated.title).toBe('Updated Title')
    expect(updated.id).toBe(session.id)
    expect(updated.updatedAt).toBeDefined()
  })

  it('should update session metadata', async () => {
    const { createSession, updateSession } = await import('../sessions')
    const session = await createSession({ title: 'Meta Session' })

    const updated = await updateSession({
      id: session.id,
      metadata: { key: 'value' }
    })
    expect(updated.metadata).toEqual({ key: 'value' })
    expect(updated.title).toBe('Meta Session') // title should be preserved
  })

  it('should throw when updating non-existent session', async () => {
    const { updateSession } = await import('../sessions')
    await expect(
      updateSession({ id: 'non-existent-id', title: 'Updated' })
    ).rejects.toThrow('Session not found: non-existent-id')
  })

  it('should delete a session', async () => {
    const { createSession, deleteSession, listSessions } = await import('../sessions')
    const session = await createSession({ title: 'To Delete' })
    expect((await listSessions()).total).toBe(1)

    await deleteSession(session.id)
    const remaining = await listSessions()
    expect(remaining.total).toBe(0)
    expect(remaining.sessions.find(s => s.id === session.id)).toBeUndefined()
  })

  it('should delete messages when deleting a session', async () => {
    const { createSession, deleteSession } = await import('../sessions')
    const session = await createSession({ title: 'Session With Messages' })

    // Seed messages for this session
    storeMock.data.set('sessions.messages', [
      { id: 'msg-1', sessionId: session.id, role: 'user', content: 'hello', timestamp: new Date().toISOString() },
      { id: 'msg-2', sessionId: session.id, role: 'assistant', content: 'hi', timestamp: new Date().toISOString() },
      { id: 'msg-3', sessionId: 'other-session', role: 'user', content: 'other', timestamp: new Date().toISOString() }
    ])

    await deleteSession(session.id)

    const remainingMessages = storeMock.data.get('sessions.messages') as Array<{ id: string; sessionId: string }>
    expect(remainingMessages).toHaveLength(1)
    expect(remainingMessages[0].sessionId).toBe('other-session')
  })

  it('should not throw when deleting non-existent session', async () => {
    const { deleteSession } = await import('../sessions')
    // Should not throw
    await deleteSession('non-existent-id')
  })

  it('should search sessions by title', async () => {
    const { createSession, searchSessions } = await import('../sessions')
    await createSession({ title: 'Python Tutorial' })
    await createSession({ title: 'JavaScript Guide' })
    await createSession({ title: 'Python Advanced' })

    const result = await searchSessions({ query: 'python' })
    expect(result).toBeDefined()
    expect(result.results).toHaveLength(2)
    expect(result.total).toBe(2)
    expect(result.query).toBe('python')
  })

  it('should respect search limit', async () => {
    const { createSession, searchSessions } = await import('../sessions')
    await createSession({ title: 'Test Session 1' })
    await createSession({ title: 'Test Session 2' })
    await createSession({ title: 'Test Session 3' })

    const result = await searchSessions({ query: 'test', limit: 2 })
    expect(result.results).toHaveLength(2)
  })

  it('should return empty results for unmatched query', async () => {
    const { createSession, searchSessions } = await import('../sessions')
    await createSession({ title: 'Python Tutorial' })

    const result = await searchSessions({ query: 'nonexistent' })
    expect(result.results).toHaveLength(0)
    expect(result.total).toBe(0)
  })

  it('should export a session with messages', async () => {
    const { createSession, exportSession } = await import('../sessions')
    const session = await createSession({ title: 'Export Me' })

    // Seed messages
    storeMock.data.set('sessions.messages', [
      { id: 'msg-1', sessionId: session.id, role: 'user', content: 'hello', timestamp: new Date().toISOString() },
      { id: 'msg-2', sessionId: session.id, role: 'assistant', content: 'hi there', timestamp: new Date().toISOString() }
    ])

    const exported = await exportSession(session.id)
    expect(exported).toBeDefined()
    expect(exported.session.id).toBe(session.id)
    expect(exported.messages).toHaveLength(2)
    expect(exported.exportedAt).toBeDefined()
    expect(exported.version).toBe('1.0.0')
  })

  it('should throw when exporting non-existent session', async () => {
    const { exportSession } = await import('../sessions')
    await expect(exportSession('non-existent-id')).rejects.toThrow('Session not found: non-existent-id')
  })

  it('should import a session with new id', async () => {
    const { importSession, listSessions } = await import('../sessions')
    const importData = {
      session: {
        id: 'old-id',
        title: 'Imported Session',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        messageCount: 1,
        isActive: false
      },
      messages: [
        { id: 'old-msg-1', sessionId: 'old-id', role: 'user' as const, content: 'hello', timestamp: '2024-01-01T00:00:00.000Z' }
      ]
    }

    const imported = await importSession(importData)
    expect(imported).toBeDefined()
    expect(imported.id).not.toBe('old-id') // Should get new id
    expect(imported.title).toBe('Imported Session')
    expect(imported.createdAt).not.toBe('2024-01-01T00:00:00.000Z') // Should get new timestamp
    expect(imported.updatedAt).not.toBe('2024-01-01T00:00:00.000Z')

    const list = await listSessions()
    expect(list.total).toBe(1)
  })

  it('should get grouped sessions', async () => {
    const { createSession, getGroupedSessions } = await import('../sessions')
    await createSession({ title: 'Session 1' })
    await createSession({ title: 'Session 2' })

    const grouped = await getGroupedSessions()
    expect(grouped).toBeDefined()
    expect(grouped.today).toBeDefined()
    expect(Array.isArray(grouped.today)).toBe(true)
    // Sessions just created should appear in today group
    expect(grouped.today.length).toBeGreaterThanOrEqual(2)
  })
})
