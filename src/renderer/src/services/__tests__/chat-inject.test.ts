import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildProjectMemoryContext } from '../chat-inject'
import * as server from '../server'

describe('chat inject - buildProjectMemoryContext (A)', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('returns context string containing memory content when memories exist', async () => {
    vi.spyOn(server, 'searchProjectMemory').mockResolvedValue([
      { content: '统一用 pnpm 安装依赖' },
      { content: '接口错误码走 BizError' }
    ] as any)

    const ctx = await buildProjectMemoryContext('如何安装依赖')
    expect(ctx).toContain('参考的项目记忆')
    expect(ctx).toContain('统一用 pnpm 安装依赖')
    expect(ctx).toContain('接口错误码走 BizError')
  })

  it('returns empty string when no memory matches', async () => {
    vi.spyOn(server, 'searchProjectMemory').mockResolvedValue([] as any)
    expect(await buildProjectMemoryContext('随便问问')).toBe('')
  })

  it('degrades to empty string when server is unreachable', async () => {
    vi.spyOn(server, 'searchProjectMemory').mockRejectedValue(new Error('network down'))
    expect(await buildProjectMemoryContext('随便问问')).toBe('')
  })
})
