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

describe('Profile Management Service', () => {
  it('should list profiles with empty result', async () => {
    const { listProfiles } = await import('../profiles')
    const result = await listProfiles()
    expect(result).toBeDefined()
    expect(Array.isArray(result.profiles)).toBe(true)
    expect(result.profiles).toHaveLength(0)
    expect(result.total).toBe(0)
    expect(result.activeProfileId).toBeNull()
  })

  it('should add a new profile', async () => {
    const { addProfile, listProfiles } = await import('../profiles')
    const newProfile = {
      name: 'Test Profile',
      color: '#007bff'
    }
    const result = await addProfile(newProfile)
    expect(result).toBeDefined()
    expect(result.id).toBeDefined()
    expect(result.name).toBe('Test Profile')
    expect(result.color).toBe('#007bff')
    expect(result.isActive).toBe(true)
    expect(result.createdAt).toBeDefined()
    expect(result.updatedAt).toBeDefined()

    const list = await listProfiles()
    expect(list.total).toBe(1)
    expect(list.profiles[0].id).toBe(result.id)
    expect(list.activeProfileId).toBe(result.id)
  })

  it('should add a profile with optional fields', async () => {
    const { addProfile } = await import('../profiles')
    const result = await addProfile({
      name: 'Full Profile',
      color: '#ff0000',
      avatar: 'avatar-url',
      description: 'A test profile',
      metadata: { key: 'value' }
    })
    expect(result.avatar).toBe('avatar-url')
    expect(result.description).toBe('A test profile')
    expect(result.metadata).toEqual({ key: 'value' })
  })

  it('should set first profile as active automatically', async () => {
    const { addProfile } = await import('../profiles')
    const first = await addProfile({ name: 'First' })
    expect(first.isActive).toBe(true)

    const second = await addProfile({ name: 'Second' })
    expect(second.isActive).toBe(false)
  })

  it('should get a profile by id', async () => {
    const { addProfile, getProfile } = await import('../profiles')
    const created = await addProfile({ name: 'My Profile' })

    const found = await getProfile(created.id)
    expect(found).toBeDefined()
    expect(found?.id).toBe(created.id)
    expect(found?.name).toBe('My Profile')
  })

  it('should return null for non-existent profile', async () => {
    const { getProfile } = await import('../profiles')
    const found = await getProfile('non-existent-id')
    expect(found).toBeNull()
  })

  it('should update a profile', async () => {
    vi.useFakeTimers()
    const { addProfile, updateProfile } = await import('../profiles')
    const created = await addProfile({ name: 'Original Name', color: '#000000' })

    // Advance time so updatedAt differs from createdAt
    vi.advanceTimersByTime(100)

    const updated = await updateProfile({
      id: created.id,
      name: 'Updated Name',
      color: '#ffffff'
    })
    expect(updated.name).toBe('Updated Name')
    expect(updated.color).toBe('#ffffff')
    expect(updated.id).toBe(created.id)
    expect(updated.updatedAt).not.toBe(created.updatedAt)
    vi.useRealTimers()
  })

  it('should update profile metadata', async () => {
    const { addProfile, updateProfile } = await import('../profiles')
    const created = await addProfile({ name: 'Meta Profile' })

    const updated = await updateProfile({
      id: created.id,
      metadata: { theme: 'dark' }
    })
    expect(updated.metadata).toEqual({ theme: 'dark' })
    expect(updated.name).toBe('Meta Profile')
  })

  it('should throw when updating non-existent profile', async () => {
    const { updateProfile } = await import('../profiles')
    await expect(
      updateProfile({ id: 'non-existent-id', name: 'Updated' })
    ).rejects.toThrow('Profile not found: non-existent-id')
  })

  it('should delete a profile', async () => {
    const { addProfile, deleteProfile, listProfiles } = await import('../profiles')
    const created = await addProfile({ name: 'To Delete' })
    expect((await listProfiles()).total).toBe(1)

    await deleteProfile(created.id)
    const remaining = await listProfiles()
    expect(remaining.total).toBe(0)
    expect(remaining.profiles.find(p => p.id === created.id)).toBeUndefined()
  })

  it('should not throw when deleting non-existent profile', async () => {
    const { deleteProfile } = await import('../profiles')
    await deleteProfile('non-existent-id')
  })

  it('should reassign active profile when deleting the active one', async () => {
    const { addProfile, deleteProfile, listProfiles } = await import('../profiles')
    const first = await addProfile({ name: 'First' })
    const second = await addProfile({ name: 'Second' })

    // First is active
    expect((await listProfiles()).activeProfileId).toBe(first.id)

    // Delete the active profile
    await deleteProfile(first.id)
    const remaining = await listProfiles()
    expect(remaining.activeProfileId).toBe(second.id)
  })

  it('should set active profile to null when deleting the only profile', async () => {
    const { addProfile, deleteProfile, listProfiles } = await import('../profiles')
    const only = await addProfile({ name: 'Only' })

    await deleteProfile(only.id)
    const remaining = await listProfiles()
    expect(remaining.activeProfileId).toBeNull()
  })

  it('should set active profile', async () => {
    const { addProfile, setActiveProfile, listProfiles } = await import('../profiles')
    const first = await addProfile({ name: 'First' })
    const second = await addProfile({ name: 'Second' })

    await setActiveProfile(second.id)
    const result = await listProfiles()
    expect(result.activeProfileId).toBe(second.id)

    // Verify isActive flags are updated
    const updatedFirst = result.profiles.find(p => p.id === first.id)!
    const updatedSecond = result.profiles.find(p => p.id === second.id)!
    expect(updatedFirst.isActive).toBe(false)
    expect(updatedSecond.isActive).toBe(true)
  })

  it('should export a profile', async () => {
    const { addProfile, exportProfile } = await import('../profiles')
    const created = await addProfile({ name: 'Export Me', color: '#abc123' })

    const exported = await exportProfile(created.id)
    expect(exported).toBeDefined()
    expect(exported.profile.id).toBe(created.id)
    expect(exported.profile.name).toBe('Export Me')
    expect(exported.exportedAt).toBeDefined()
    expect(exported.version).toBe('1.0.0')
  })

  it('should throw when exporting non-existent profile', async () => {
    const { exportProfile } = await import('../profiles')
    await expect(exportProfile('non-existent-id')).rejects.toThrow('Profile not found: non-existent-id')
  })

  it('should import a profile with new id', async () => {
    const { importProfile, listProfiles } = await import('../profiles')
    const importData = {
      profile: {
        id: 'old-id',
        name: 'Imported Profile',
        color: '#ff0000',
        isActive: true,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z'
      }
    }

    const imported = await importProfile(importData)
    expect(imported).toBeDefined()
    expect(imported.id).not.toBe('old-id')
    expect(imported.name).toBe('Imported Profile')
    expect(imported.isActive).toBe(false)
    expect(imported.createdAt).not.toBe('2024-01-01T00:00:00.000Z')
    expect(imported.updatedAt).not.toBe('2024-01-01T00:00:00.000Z')

    const list = await listProfiles()
    expect(list.total).toBe(1)
  })
})
