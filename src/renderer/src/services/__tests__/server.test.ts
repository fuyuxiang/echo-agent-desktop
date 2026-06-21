import { describe, it, expect, vi, beforeEach } from 'vitest'
import { login } from '../server'
import { request } from '@/request'

vi.mock('@/request', () => ({ request: { post: vi.fn(), get: vi.fn() } }))

describe('server service', () => {
  beforeEach(() => vi.clearAllMocks())
  it('login posts credentials and returns token+user', async () => {
    ;(request.post as any).mockResolvedValue({
      token: 't1',
      user: { id: 'u1', username: 'a', role: 'member', groupId: 'g1' }
    })
    const res = await login('a', 'pw')
    expect(request.post).toHaveBeenCalledWith('/api/auth/login', { username: 'a', password: 'pw' })
    expect(res.token).toBe('t1')
    expect(res.user.groupId).toBe('g1')
  })
})
