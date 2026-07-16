import { describe, it, expect, vi, beforeEach } from 'vitest'

const { handlers, profileService } = vi.hoisted(() => {
  const handlers = new Map<string, (...a: unknown[]) => unknown>()
  const profileService = {
    listProfiles: vi.fn(async () => ({
      profiles: [],
      total: 0,
      activeProfileId: null
    })),
    getProfile: vi.fn(async (_id: string) => null),
    addProfile: vi.fn(async (req: unknown) => ({
      id: 'new-id',
      name: 'New Profile',
      color: '#007bff',
      isActive: true,
      createdAt: '',
      updatedAt: '',
      ...(req as Record<string, unknown>)
    })),
    updateProfile: vi.fn(async (req: unknown) => ({ id: 'u-id', ...(req as object) })),
    deleteProfile: vi.fn(async (_id: string) => undefined),
    setActiveProfile: vi.fn(async (_id: string) => undefined),
    exportProfile: vi.fn(async (_id: string) => ({
      profile: { id: 'p1', name: 'Test', color: '#000', isActive: true, createdAt: '', updatedAt: '' },
      exportedAt: '',
      version: '1.0.0'
    })),
    importProfile: vi.fn(async (data: unknown) => ({
      id: 'imported-id',
      name: 'imported',
      color: '#000',
      isActive: false,
      createdAt: '',
      updatedAt: '',
      ...((data as Record<string, unknown>)?.profile ?? {})
    }))
  }
  return { handlers, profileService }
})

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) }
}))
vi.mock('../../profiles', () => profileService)

import { registerProfileIpcHandlers } from '../profiles'
import { IpcChannels } from '@shared/ipc-channels'

describe('profile IPC handlers', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    registerProfileIpcHandlers()
  })

  function invoke(ch: string, ...args: unknown[]): unknown {
    return handlers.get(ch)!({}, ...args)
  }

  it('registers all eight profile channels', () => {
    const expected = [
      IpcChannels.profiles.list,
      IpcChannels.profiles.get,
      IpcChannels.profiles.add,
      IpcChannels.profiles.update,
      IpcChannels.profiles.delete,
      IpcChannels.profiles.setActive,
      IpcChannels.profiles.export,
      IpcChannels.profiles.import
    ]
    for (const ch of expected) {
      expect(handlers.has(ch), `missing handler for ${ch}`).toBe(true)
    }
  })

  it('profiles:list delegates to listProfiles', async () => {
    const fakeResponse = {
      profiles: [{ id: 'p1', name: 'Test', color: '#000', isActive: true, createdAt: '', updatedAt: '' }],
      total: 1,
      activeProfileId: 'p1'
    }
    profileService.listProfiles.mockResolvedValueOnce(fakeResponse as any)
    const result = await invoke(IpcChannels.profiles.list)
    expect(profileService.listProfiles).toHaveBeenCalled()
    expect(result).toEqual(fakeResponse)
  })

  it('profiles:get passes id to getProfile', async () => {
    const fakeProfile = { id: 'p1', name: 'Test Profile', color: '#000', isActive: true, createdAt: '', updatedAt: '' }
    profileService.getProfile.mockResolvedValueOnce(fakeProfile as any)
    const result = await invoke(IpcChannels.profiles.get, 'p1')
    expect(profileService.getProfile).toHaveBeenCalledWith('p1')
    expect(result).toEqual(fakeProfile)
  })

  it('profiles:add passes request to addProfile', async () => {
    const req = { name: 'New Profile', color: '#ff0000' }
    const created = { id: 'new-id', name: 'New Profile', color: '#ff0000', isActive: true, createdAt: '', updatedAt: '' }
    profileService.addProfile.mockResolvedValueOnce(created)
    const result = await invoke(IpcChannels.profiles.add, req)
    expect(profileService.addProfile).toHaveBeenCalledWith(req)
    expect(result).toEqual(created)
  })

  it('profiles:update passes request to updateProfile', async () => {
    const req = { id: 'p1', name: 'Updated Name' }
    const updated = { id: 'p1', name: 'Updated Name', color: '#000', isActive: true, createdAt: '', updatedAt: '' }
    profileService.updateProfile.mockResolvedValueOnce(updated)
    const result = await invoke(IpcChannels.profiles.update, req)
    expect(profileService.updateProfile).toHaveBeenCalledWith(req)
    expect(result).toEqual(updated)
  })

  it('profiles:delete passes id to deleteProfile', async () => {
    await invoke(IpcChannels.profiles.delete, 'p1')
    expect(profileService.deleteProfile).toHaveBeenCalledWith('p1')
  })

  it('profiles:setActive passes id to setActiveProfile', async () => {
    await invoke(IpcChannels.profiles.setActive, 'p1')
    expect(profileService.setActiveProfile).toHaveBeenCalledWith('p1')
  })

  it('profiles:export passes id to exportProfile', async () => {
    const exportData = {
      profile: { id: 'p1', name: 'Test', color: '#000', isActive: true, createdAt: '', updatedAt: '' },
      exportedAt: '2024-01-01',
      version: '1.0.0'
    }
    profileService.exportProfile.mockResolvedValueOnce(exportData)
    const result = await invoke(IpcChannels.profiles.export, 'p1')
    expect(profileService.exportProfile).toHaveBeenCalledWith('p1')
    expect(result).toEqual(exportData)
  })

  it('profiles:import passes data to importProfile', async () => {
    const importData = {
      profile: { id: 'old-id', name: 'Imported', color: '#000', isActive: true, createdAt: '', updatedAt: '' }
    }
    const imported = { id: 'new-id', name: 'Imported', color: '#000', isActive: false, createdAt: '', updatedAt: '' }
    profileService.importProfile.mockResolvedValueOnce(imported)
    const result = await invoke(IpcChannels.profiles.import, importData)
    expect(profileService.importProfile).toHaveBeenCalledWith(importData)
    expect(result).toEqual(imported)
  })
})
