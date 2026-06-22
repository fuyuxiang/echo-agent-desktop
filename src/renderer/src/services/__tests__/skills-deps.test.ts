import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/services/agent/proxy-request', () => ({
  agentRequest: { get: vi.fn(), post: vi.fn(), delete: vi.fn() }
}))
vi.mock('@/stores/agentStore', () => ({
  useAgentStore: { getState: () => ({ baseUrl: 'http://127.0.0.1:9000' }) }
}))

import { agentRequest } from '@/services/agent/proxy-request'
import { skillsAPI } from '@/services/agent/skills'
import { AgentApiUrls } from '@/request/urls'

describe('skillsAPI deps', () => {
  beforeEach(() => vi.clearAllMocks())

  it('getDeps 调用正确 URL 并解包', async () => {
    ;(agentRequest.get as any).mockResolvedValue({
      data: { name: 'ppt-author', requires: ['python-pptx'], missing: [], satisfied: true }
    })
    const res = await skillsAPI.getDeps('ppt-author')
    expect(agentRequest.get).toHaveBeenCalledWith(
      `http://127.0.0.1:9000${AgentApiUrls.skillDeps('ppt-author')}`
    )
    expect(res.satisfied).toBe(true)
  })

  it('installDeps 调用 POST 并解包', async () => {
    ;(agentRequest.post as any).mockResolvedValue({
      data: { success: true, installed: ['python-pptx'], skipped: [], rejected: [], detail: 'ok' }
    })
    const res = await skillsAPI.installDeps('ppt-author')
    expect(agentRequest.post).toHaveBeenCalledWith(
      `http://127.0.0.1:9000${AgentApiUrls.skillInstallDeps('ppt-author')}`
    )
    expect(res.success).toBe(true)
  })
})
