import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) },
  app: { getPath: () => '/tmp', getAppPath: () => '/tmp' }
}))
vi.mock('../../db/dao/session', () => ({
  listChatSessions: () => [{ chatId: 'c1' }],
  deleteChatSession: vi.fn()
}))
vi.mock('../../store', () => ({ secureGet: () => 'fake-key' }))
const sendSpy = vi.fn()
const abortSpy = vi.fn()

import { IpcChannels } from '@shared/ipc-channels'
import { registerAgentChatIpc } from '../agent-chat'
import { resetAgentRuntimeForTest } from '../../agent/runtime-singleton'

beforeEach(() => {
  handlers.clear()
  sendSpy.mockClear()
  abortSpy.mockClear()
  registerAgentChatIpc()
})
afterEach(() => resetAgentRuntimeForTest())

function invoke(ch: string, ...a: unknown[]): unknown {
  return handlers.get(ch)!({}, ...a)
}

describe('agent-chat IPC', () => {
  it('未初始化 send 不抛(优雅降级)', () => {
    expect(() => invoke(IpcChannels.agentChat.send, { chatId: 'c1', text: 'hi' })).not.toThrow()
  })
  it('init 后 send 转 runtime.send', async () => {
    resetAgentRuntimeForTest({ send: sendSpy, abort: abortSpy } as never)
    await invoke(IpcChannels.agentChat.send, { chatId: 'c1', text: 'hi' })
    expect(sendSpy).toHaveBeenCalledWith('c1', 'hi')
  })
  it('listSessions 走 db dao', () => {
    expect(invoke(IpcChannels.agentChat.listSessions)).toEqual([{ chatId: 'c1' }])
  })
})
