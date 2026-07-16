import { describe, it, expect, vi, beforeEach } from 'vitest'

const { handlers, modelService } = vi.hoisted(() => {
  const handlers = new Map<string, (...a: unknown[]) => unknown>()
  const modelService = {
    listModels: vi.fn(async () => ({ models: [], total: 0 })),
    getModel: vi.fn(async (_id: string) => null),
    addModel: vi.fn(async (req: unknown) => ({ id: 'new-id', ...req as object })),
    updateModel: vi.fn(async (req: unknown) => ({ id: 'u-id', ...req as object })),
    removeModel: vi.fn(async (_id: string) => undefined),
    setActiveModel: vi.fn(async (_id: string) => undefined)
  }
  return { handlers, modelService }
})

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) }
}))
vi.mock('../../models', () => modelService)

import { registerModelIpcHandlers } from '../models'
import { IpcChannels } from '@shared/ipc-channels'

describe('model IPC handlers', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    registerModelIpcHandlers()
  })

  function invoke(ch: string, ...args: unknown[]): unknown {
    return handlers.get(ch)!({}, ...args)
  }

  it('registers all six model channels', () => {
    const expected = [
      IpcChannels.models.list,
      IpcChannels.models.get,
      IpcChannels.models.add,
      IpcChannels.models.update,
      IpcChannels.models.remove,
      IpcChannels.models.setActive
    ]
    for (const ch of expected) {
      expect(handlers.has(ch), `missing handler for ${ch}`).toBe(true)
    }
  })

  it('models:list delegates to listModels', async () => {
    modelService.listModels.mockResolvedValueOnce({ models: [{ id: 'm1' }], total: 1 } as any)
    const result = await invoke(IpcChannels.models.list)
    expect(modelService.listModels).toHaveBeenCalled()
    expect(result).toEqual({ models: [{ id: 'm1' }], total: 1 })
  })

  it('models:get passes id to getModel', async () => {
    const fakeModel = { id: 'm1', name: 'GPT-4' }
    modelService.getModel.mockResolvedValueOnce(fakeModel as any)
    const result = await invoke(IpcChannels.models.get, 'm1')
    expect(modelService.getModel).toHaveBeenCalledWith('m1')
    expect(result).toEqual(fakeModel)
  })

  it('models:add passes request to addModel', async () => {
    const req = { name: 'Claude', provider: 'anthropic', contextWindow: 200000, maxTokens: 8192 }
    const created = { id: 'new-id', ...req }
    modelService.addModel.mockResolvedValueOnce(created)
    const result = await invoke(IpcChannels.models.add, req)
    expect(modelService.addModel).toHaveBeenCalledWith(req)
    expect(result).toEqual(created)
  })

  it('models:update passes request to updateModel', async () => {
    const req = { id: 'm1', name: 'Updated' }
    const updated = { id: 'm1', name: 'Updated' }
    modelService.updateModel.mockResolvedValueOnce(updated)
    const result = await invoke(IpcChannels.models.update, req)
    expect(modelService.updateModel).toHaveBeenCalledWith(req)
    expect(result).toEqual(updated)
  })

  it('models:remove passes id to removeModel', async () => {
    await invoke(IpcChannels.models.remove, 'm1')
    expect(modelService.removeModel).toHaveBeenCalledWith('m1')
  })

  it('models:setActive passes id to setActiveModel', async () => {
    await invoke(IpcChannels.models.setActive, 'm1')
    expect(modelService.setActiveModel).toHaveBeenCalledWith('m1')
  })
})
