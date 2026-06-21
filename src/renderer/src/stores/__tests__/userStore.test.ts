import { describe, it, expect, vi, beforeEach } from 'vitest'

// persist 中间件会在 setState 时落盘(electron-store 经由 window.api),node 环境下打桩规避
vi.stubGlobal('window', {
  api: { store: { set: vi.fn(async () => {}), get: vi.fn(async () => null), delete: vi.fn(async () => {}) } }
})

vi.mock('@/services/server', () => ({
  login: vi.fn(async () => ({
    token: 't1',
    user: { id: 'u1', username: 'a', role: 'member', groupId: 'g1' }
  }))
}))
const { secureSet, secureRemove } = vi.hoisted(() => ({
  secureSet: vi.fn(),
  secureRemove: vi.fn()
}))
vi.mock('@/utils', () => ({
  storage: { secure: { set: secureSet, get: vi.fn(), remove: secureRemove } }
}))

import { useUserStore } from '../userStore'

describe('userStore auth', () => {
  beforeEach(() => {
    useUserStore.setState({ user: null, isAuthed: false })
    secureSet.mockClear()
    secureRemove.mockClear()
  })

  it('signIn stores token securely and sets user', async () => {
    await useUserStore.getState().signIn('a', 'pw')
    expect(secureSet).toHaveBeenCalledWith('token', 't1')
    expect(useUserStore.getState().user?.groupId).toBe('g1')
    expect(useUserStore.getState().isAuthed).toBe(true)
  })

  it('signOut clears token and user', () => {
    useUserStore.setState({ user: { id: 'u1', username: 'a', role: 'member', groupId: 'g1' }, isAuthed: true })
    useUserStore.getState().signOut()
    expect(secureRemove).toHaveBeenCalledWith('token')
    expect(useUserStore.getState().user).toBeNull()
    expect(useUserStore.getState().isAuthed).toBe(false)
  })
})
