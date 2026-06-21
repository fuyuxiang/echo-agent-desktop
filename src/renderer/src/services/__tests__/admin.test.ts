import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  adminListUsers,
  adminCreateUser,
  adminUpdateUser,
  adminListGroups,
  adminCreateGroup
} from '../server'
import { request } from '@/request'
import { ServerApiUrls } from '@/request/urls'

vi.mock('@/request', () => ({
  request: { get: vi.fn(), post: vi.fn(), patch: vi.fn() }
}))

describe('admin services', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lists users', async () => {
    ;(request.get as any).mockResolvedValue([{ id: 'u1', username: 'a', role: 'member', groupId: null }])
    const res = await adminListUsers()
    expect(request.get).toHaveBeenCalledWith(ServerApiUrls.adminUsers)
    expect(res[0].id).toBe('u1')
  })

  it('lists groups', async () => {
    ;(request.get as any).mockResolvedValue([{ id: 'g1', name: '研发', createdAt: 1 }])
    const res = await adminListGroups()
    expect(request.get).toHaveBeenCalledWith(ServerApiUrls.adminGroups)
    expect(res[0].name).toBe('研发')
  })

  it('creates a group', async () => {
    ;(request.post as any).mockResolvedValue({ id: 'g1', name: '研发', createdAt: 1 })
    await adminCreateGroup('研发')
    expect(request.post).toHaveBeenCalledWith(ServerApiUrls.adminGroups, { name: '研发' })
  })

  it('creates a user with group', async () => {
    ;(request.post as any).mockResolvedValue({ id: 'u1' })
    await adminCreateUser({ username: 'm', password: 'pw', role: 'member', groupId: 'g1' })
    expect(request.post).toHaveBeenCalledWith(ServerApiUrls.adminUsers, {
      username: 'm',
      password: 'pw',
      role: 'member',
      groupId: 'g1'
    })
  })

  it('updates a user group/disabled', async () => {
    ;(request.patch as any).mockResolvedValue({ updated: true })
    await adminUpdateUser('u1', { groupId: 'g2', disabled: true })
    expect(request.patch).toHaveBeenCalledWith(`${ServerApiUrls.adminUsers}/u1`, {
      groupId: 'g2',
      disabled: true
    })
  })
})
