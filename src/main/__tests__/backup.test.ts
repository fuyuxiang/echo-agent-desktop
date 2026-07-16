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

describe('Backup Management Service', () => {
  it('should list backups with empty result', async () => {
    const { listBackups } = await import('../backup')
    const result = await listBackups()
    expect(result).toBeDefined()
    expect(Array.isArray(result.backups)).toBe(true)
    expect(result.backups).toHaveLength(0)
    expect(result.total).toBe(0)
  })

  it('should create a backup', async () => {
    const { createBackup, listBackups } = await import('../backup')
    const request = {
      name: 'Test Backup',
      description: 'Test description'
    }
    const result = await createBackup(request)
    expect(result).toBeDefined()
    expect(result.id).toBeDefined()
    expect(result.name).toBe('Test Backup')
    expect(result.description).toBe('Test description')
    expect(result.size).toBe(0)
    expect(result.createdAt).toBeDefined()

    const list = await listBackups()
    expect(list.total).toBe(1)
    expect(list.backups[0].id).toBe(result.id)
  })

  it('should create a backup with optional fields', async () => {
    const { createBackup } = await import('../backup')
    const result = await createBackup({
      name: 'Full Backup',
      description: 'Complete backup',
      metadata: { type: 'full', version: '1.0' }
    })
    expect(result.metadata).toEqual({ type: 'full', version: '1.0' })
  })

  it('should create multiple backups', async () => {
    const { createBackup, listBackups } = await import('../backup')
    await createBackup({ name: 'Backup 1' })
    await createBackup({ name: 'Backup 2' })
    await createBackup({ name: 'Backup 3' })

    const list = await listBackups()
    expect(list.total).toBe(3)
    expect(list.backups.map(b => b.name)).toEqual(['Backup 1', 'Backup 2', 'Backup 3'])
  })

  it('should restore a backup', async () => {
    const { createBackup, restoreBackup } = await import('../backup')
    const created = await createBackup({ name: 'Restore Test' })

    await expect(restoreBackup({ id: created.id })).resolves.not.toThrow()
  })

  it('should throw when restoring non-existent backup', async () => {
    const { restoreBackup } = await import('../backup')
    await expect(
      restoreBackup({ id: 'non-existent-id' })
    ).rejects.toThrow('Backup not found: non-existent-id')
  })

  it('should delete a backup', async () => {
    const { createBackup, deleteBackup, listBackups } = await import('../backup')
    const created = await createBackup({ name: 'To Delete' })
    expect((await listBackups()).total).toBe(1)

    await deleteBackup(created.id)
    const remaining = await listBackups()
    expect(remaining.total).toBe(0)
    expect(remaining.backups.find(b => b.id === created.id)).toBeUndefined()
  })

  it('should not throw when deleting non-existent backup', async () => {
    const { deleteBackup } = await import('../backup')
    await deleteBackup('non-existent-id')
  })

  it('should delete only the specified backup', async () => {
    const { createBackup, deleteBackup, listBackups } = await import('../backup')
    const first = await createBackup({ name: 'Keep' })
    const second = await createBackup({ name: 'Delete' })

    await deleteBackup(second.id)
    const remaining = await listBackups()
    expect(remaining.total).toBe(1)
    expect(remaining.backups[0].id).toBe(first.id)
    expect(remaining.backups[0].name).toBe('Keep')
  })

  it('should generate unique ids for each backup', async () => {
    const { createBackup } = await import('../backup')
    const first = await createBackup({ name: 'First' })
    const second = await createBackup({ name: 'Second' })
    expect(first.id).not.toBe(second.id)
  })

  it('should store backup with current timestamp', async () => {
    const { createBackup } = await import('../backup')
    const before = new Date().toISOString()
    const result = await createBackup({ name: 'Timestamped' })
    const after = new Date().toISOString()

    expect(result.createdAt).toBeDefined()
    expect(result.createdAt >= before).toBe(true)
    expect(result.createdAt <= after).toBe(true)
  })
})
