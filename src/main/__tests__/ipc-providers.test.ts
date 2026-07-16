import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electron
const handleMock = vi.fn()
vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  }
}))

// Mock providers service
vi.mock('../providers', () => ({
  listProviders: vi.fn(),
  addProvider: vi.fn(),
  updateProvider: vi.fn(),
  removeProvider: vi.fn(),
  getProvider: vi.fn(),
  testProvider: vi.fn()
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Provider IPC Handlers', () => {
  it('should register all provider IPC handlers', async () => {
    const { registerProviderIpcHandlers } = await import('../ipc/providers')
    registerProviderIpcHandlers()

    expect(handleMock).toHaveBeenCalledWith('providers:list', expect.any(Function))
    expect(handleMock).toHaveBeenCalledWith('providers:add', expect.any(Function))
    expect(handleMock).toHaveBeenCalledWith('providers:update', expect.any(Function))
    expect(handleMock).toHaveBeenCalledWith('providers:remove', expect.any(Function))
    expect(handleMock).toHaveBeenCalledWith('providers:get', expect.any(Function))
    expect(handleMock).toHaveBeenCalledWith('providers:test', expect.any(Function))
    expect(handleMock).toHaveBeenCalledTimes(6)
  })

  it('should call listProviders when providers:list is invoked', async () => {
    const { registerProviderIpcHandlers } = await import('../ipc/providers')
    const { listProviders } = await import('../providers')
    const mockResponse = { providers: [], total: 0 }
    vi.mocked(listProviders).mockResolvedValue(mockResponse)

    registerProviderIpcHandlers()

    // Get the handler registered for 'providers:list'
    const listHandler = handleMock.mock.calls.find(
      (call: unknown[]) => call[0] === 'providers:list'
    )?.[1] as (() => Promise<unknown>) | undefined
    expect(listHandler).toBeDefined()

    const result = await listHandler!()
    expect(result).toEqual(mockResponse)
    expect(listProviders).toHaveBeenCalled()
  })

  it('should call addProvider with request when providers:add is invoked', async () => {
    const { registerProviderIpcHandlers } = await import('../ipc/providers')
    const { addProvider } = await import('../providers')
    const mockRequest = { name: 'OpenAI', type: 'openai', apiKey: 'sk-test' }
    const mockResponse = { id: 'test-id', ...mockRequest, isActive: true, models: [], createdAt: '', updatedAt: '' }
    vi.mocked(addProvider).mockResolvedValue(mockResponse as never)

    registerProviderIpcHandlers()

    const addHandler = handleMock.mock.calls.find(
      (call: unknown[]) => call[0] === 'providers:add'
    )?.[1] as ((_: unknown, request: unknown) => Promise<unknown>) | undefined
    expect(addHandler).toBeDefined()

    const result = await addHandler!(null, mockRequest)
    expect(result).toEqual(mockResponse)
    expect(addProvider).toHaveBeenCalledWith(mockRequest)
  })

  it('should call updateProvider with request when providers:update is invoked', async () => {
    const { registerProviderIpcHandlers } = await import('../ipc/providers')
    const { updateProvider } = await import('../providers')
    const mockRequest = { id: 'test-id', name: 'Updated' }
    const mockResponse = { id: 'test-id', name: 'Updated', type: 'openai', isActive: true, models: [], createdAt: '', updatedAt: '' }
    vi.mocked(updateProvider).mockResolvedValue(mockResponse as never)

    registerProviderIpcHandlers()

    const updateHandler = handleMock.mock.calls.find(
      (call: unknown[]) => call[0] === 'providers:update'
    )?.[1] as ((_: unknown, request: unknown) => Promise<unknown>) | undefined
    expect(updateHandler).toBeDefined()

    const result = await updateHandler!(null, mockRequest)
    expect(result).toEqual(mockResponse)
    expect(updateProvider).toHaveBeenCalledWith(mockRequest)
  })

  it('should call removeProvider with id when providers:remove is invoked', async () => {
    const { registerProviderIpcHandlers } = await import('../ipc/providers')
    const { removeProvider } = await import('../providers')
    vi.mocked(removeProvider).mockResolvedValue(undefined)

    registerProviderIpcHandlers()

    const removeHandler = handleMock.mock.calls.find(
      (call: unknown[]) => call[0] === 'providers:remove'
    )?.[1] as ((_: unknown, id: string) => Promise<unknown>) | undefined
    expect(removeHandler).toBeDefined()

    await removeHandler!(null, 'test-id')
    expect(removeProvider).toHaveBeenCalledWith('test-id')
  })

  it('should call getProvider with id when providers:get is invoked', async () => {
    const { registerProviderIpcHandlers } = await import('../ipc/providers')
    const { getProvider } = await import('../providers')
    const mockResponse = { id: 'test-id', name: 'OpenAI', type: 'openai', isActive: true, models: [], createdAt: '', updatedAt: '' }
    vi.mocked(getProvider).mockResolvedValue(mockResponse as never)

    registerProviderIpcHandlers()

    const getHandler = handleMock.mock.calls.find(
      (call: unknown[]) => call[0] === 'providers:get'
    )?.[1] as ((_: unknown, id: string) => Promise<unknown>) | undefined
    expect(getHandler).toBeDefined()

    const result = await getHandler!(null, 'test-id')
    expect(result).toEqual(mockResponse)
    expect(getProvider).toHaveBeenCalledWith('test-id')
  })

  it('should call testProvider with request when providers:test is invoked', async () => {
    const { registerProviderIpcHandlers } = await import('../ipc/providers')
    const { testProvider } = await import('../providers')
    const mockRequest = { id: 'test-id' }
    const mockResponse = { success: true, message: 'Connection successful', latency: 100 }
    vi.mocked(testProvider).mockResolvedValue(mockResponse)

    registerProviderIpcHandlers()

    const testHandler = handleMock.mock.calls.find(
      (call: unknown[]) => call[0] === 'providers:test'
    )?.[1] as ((_: unknown, request: unknown) => Promise<unknown>) | undefined
    expect(testHandler).toBeDefined()

    const result = await testHandler!(null, mockRequest)
    expect(result).toEqual(mockResponse)
    expect(testProvider).toHaveBeenCalledWith(mockRequest)
  })
})
