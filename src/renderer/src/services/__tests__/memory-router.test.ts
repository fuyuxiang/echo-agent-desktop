import { describe, it, expect, vi, beforeEach } from 'vitest'
import { confirmShareToProject } from '../memory-router'
import * as server from '../server'

vi.spyOn(server, 'writeProjectMemory').mockResolvedValue({ id: 'm1' } as any)

describe('memory router (D)', () => {
  beforeEach(() => vi.clearAllMocks())
  it('share writes to project memory', async () => {
    const r = await confirmShareToProject({ content: '规范', tags: [] }, 'share')
    expect(server.writeProjectMemory).toHaveBeenCalledWith('规范', [])
    expect(r.shared).toBe(true)
  })
  it('local/discard does not call server', async () => {
    expect((await confirmShareToProject({ content: 'x', tags: [] }, 'local')).shared).toBe(false)
    expect((await confirmShareToProject({ content: 'x', tags: [] }, 'discard')).shared).toBe(false)
    expect(server.writeProjectMemory).not.toHaveBeenCalled()
  })
})
