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

describe('Logs Management Service', () => {
  it('should list logs with empty result', async () => {
    const { listLogs } = await import('../logs')
    const result = await listLogs()
    expect(result).toBeDefined()
    expect(Array.isArray(result.logs)).toBe(true)
    expect(result.logs).toHaveLength(0)
    expect(result.total).toBe(0)
  })

  it('should add a log entry', async () => {
    const { addLog, listLogs } = await import('../logs')
    const log = await addLog('info', 'Test message')
    expect(log).toBeDefined()
    expect(log.id).toBeDefined()
    expect(log.level).toBe('info')
    expect(log.message).toBe('Test message')
    expect(log.timestamp).toBeDefined()

    const list = await listLogs()
    expect(list.total).toBe(1)
    expect(list.logs[0].id).toBe(log.id)
  })

  it('should clear all logs', async () => {
    const { addLog, clearLogs, listLogs } = await import('../logs')
    await addLog('info', 'Test message 1')
    await addLog('info', 'Test message 2')
    await clearLogs()
    const result = await listLogs()
    expect(result.total).toBe(0)
  })

  it('should get log by id', async () => {
    const { addLog, getLogById } = await import('../logs')
    const log = await addLog('info', 'Test message')
    const found = await getLogById(log.id)
    expect(found).toBeDefined()
    expect(found?.id).toBe(log.id)
  })

  it('should delete a log', async () => {
    const { addLog, deleteLog, getLogById } = await import('../logs')
    const log = await addLog('info', 'Test message')
    await deleteLog(log.id)
    const found = await getLogById(log.id)
    expect(found).toBeNull()
  })

  it('should get log stats', async () => {
    const { addLog, getLogStats } = await import('../logs')
    await addLog('info', 'Info message')
    await addLog('error', 'Error message')
    await addLog('warn', 'Warning message')
    const stats = await getLogStats()
    expect(stats.total).toBe(3)
    expect(stats.byLevel.info).toBe(1)
    expect(stats.byLevel.error).toBe(1)
    expect(stats.byLevel.warn).toBe(1)
  })

  it('should filter logs by level', async () => {
    const { addLog, listLogs } = await import('../logs')
    await addLog('info', 'Info message')
    await addLog('error', 'Error message')
    const result = await listLogs({ level: 'error' })
    expect(result.logs.length).toBe(1)
    expect(result.logs[0].level).toBe('error')
  })
})
