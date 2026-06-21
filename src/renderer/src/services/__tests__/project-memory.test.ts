import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  searchProjectMemory,
  writeProjectMemory,
  listProjectMemory,
  deleteProjectMemory
} from '../server'
import { request } from '@/request'
import { ServerApiUrls } from '@/request/urls'

vi.mock('@/request', () => ({
  request: { post: vi.fn(), get: vi.fn(), delete: vi.fn() }
}))

describe('project memory service', () => {
  beforeEach(() => vi.clearAllMocks())

  it('search posts query without group_id', async () => {
    ;(request.post as any).mockResolvedValue([])
    await searchProjectMemory('部署', 3)
    expect(request.post).toHaveBeenCalledWith(ServerApiUrls.projectMemorySearch, {
      query: '部署',
      topK: 3
    })
  })

  it('search uses default topK when omitted', async () => {
    ;(request.post as any).mockResolvedValue([])
    await searchProjectMemory('部署')
    expect(request.post).toHaveBeenCalledWith(ServerApiUrls.projectMemorySearch, {
      query: '部署',
      topK: 5
    })
  })

  it('write posts content and tags', async () => {
    ;(request.post as any).mockResolvedValue({ id: 'm1' })
    await writeProjectMemory('内容', ['t'])
    expect(request.post).toHaveBeenCalledWith(ServerApiUrls.projectMemory, {
      content: '内容',
      tags: ['t']
    })
  })

  it('write defaults tags to empty array', async () => {
    ;(request.post as any).mockResolvedValue({ id: 'm1' })
    await writeProjectMemory('内容')
    expect(request.post).toHaveBeenCalledWith(ServerApiUrls.projectMemory, {
      content: '内容',
      tags: []
    })
  })

  it('list gets with limit and offset params', async () => {
    ;(request.get as any).mockResolvedValue([])
    await listProjectMemory(10, 20)
    expect(request.get).toHaveBeenCalledWith(ServerApiUrls.projectMemory, {
      params: { limit: 10, offset: 20 }
    })
  })

  it('list uses default limit and offset', async () => {
    ;(request.get as any).mockResolvedValue([])
    await listProjectMemory()
    expect(request.get).toHaveBeenCalledWith(ServerApiUrls.projectMemory, {
      params: { limit: 50, offset: 0 }
    })
  })

  it('delete calls delete with id in path', async () => {
    ;(request.delete as any).mockResolvedValue({ deleted: true })
    const res = await deleteProjectMemory('m1')
    expect(request.delete).toHaveBeenCalledWith(`${ServerApiUrls.projectMemory}/m1`)
    expect(res.deleted).toBe(true)
  })
})
