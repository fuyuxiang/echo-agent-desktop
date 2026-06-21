import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  listPersonalMemory,
  searchPersonalMemory,
  deletePersonalMemory
} from '../agent-memory'
import { agentHttp } from '@/utils/agent'
import { AgentApiUrls } from '@/request/urls'

vi.mock('@/utils/agent', () => ({ agentHttp: vi.fn() }))

describe('agent memory service', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lists personal memory from local agent', async () => {
    ;(agentHttp as any).mockResolvedValue([
      { id: 'p1', type: 'user', tier: 'semantic', key: 'k', content: 'c', tags: [], importance: 0.5 }
    ])
    const res = await listPersonalMemory()
    expect(agentHttp).toHaveBeenCalledWith(AgentApiUrls.memory)
    expect(res[0].id).toBe('p1')
  })

  it('searches personal memory via POST with query body', async () => {
    ;(agentHttp as any).mockResolvedValue([])
    await searchPersonalMemory('部署')
    expect(agentHttp).toHaveBeenCalledWith(AgentApiUrls.memorySearch, {
      method: 'POST',
      body: { query: '部署' }
    })
  })

  it('deletes personal memory via DELETE with id in path', async () => {
    ;(agentHttp as any).mockResolvedValue(undefined)
    await deletePersonalMemory('p1')
    expect(agentHttp).toHaveBeenCalledWith(AgentApiUrls.memoryDetail('p1'), { method: 'DELETE' })
  })
})
