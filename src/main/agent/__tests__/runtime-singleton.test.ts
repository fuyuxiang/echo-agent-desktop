import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const sent: Array<{ channel: string; payload: unknown }> = []
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      { webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } }
    ]
  },
  app: { getPath: () => '/tmp', getAppPath: () => '/tmp' }
}))
vi.mock('../../store', () => ({ secureGet: () => 'fake-key' }))
const initMem = vi.fn()
vi.mock('../memory/singleton', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../memory/singleton')>()
  return {
    ...actual,
    initMemoryManager: (...a: unknown[]) => initMem(...a)
  }
})

import { initAgentRuntime, getAgentRuntime, resetAgentRuntimeForTest } from '../runtime-singleton'
import { IpcChannels } from '@shared/ipc-channels'
import type { RuntimeEventHandler } from '../runtime/events'
import { AgentRuntime } from '../runtime/AgentRuntime'

beforeEach(() => {
  sent.length = 0
  initMem.mockClear()
})
afterEach(() => resetAgentRuntimeForTest())

describe('runtime singleton', () => {
  it('init 前 get 返回 null', () => {
    expect(getAgentRuntime()).toBeNull()
  })
  it('init 装配 runtime 并调 initMemoryManager', () => {
    initAgentRuntime({
      providerId: 'deepseek',
      model: 'deepseek-chat',
      baseUrl: '',
      apiKeyStoreKey: 'deepseek-api-key'
    })
    expect(getAgentRuntime()).not.toBeNull()
    expect(initMem).toHaveBeenCalledTimes(1)
  })
  it('runtime on 注册的 handler 把事件路由到 webContents(agent:chat:event)', () => {
    // spy prototype.on 拦截所有 AgentRuntime 实例的 on 调用
    const onSpy = vi.spyOn(AgentRuntime.prototype, 'on')
    initAgentRuntime({
      providerId: 'deepseek',
      model: 'deepseek-chat',
      baseUrl: '',
      apiKeyStoreKey: 'deepseek-api-key'
    })
    const registeredHandler = onSpy.mock.calls[0]?.[0] as RuntimeEventHandler | undefined
    expect(registeredHandler).toBeDefined()
    sent.length = 0
    registeredHandler!({ type: 'done', chatId: 'c1' })
    expect(sent.some((s) => s.channel === IpcChannels.agentChat.event)).toBe(true)
  })
})
