import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) },
  BrowserWindow: { getAllWindows: () => [] }
}))

const gw = { switchSession: vi.fn(), send: vi.fn(), connect: vi.fn(), disconnect: vi.fn() }
vi.mock('../../echo-agent', () => ({
  getGatewayClient: vi.fn(() => gw),
  resetGatewayClient: vi.fn()
}))
vi.mock('../../db/dao/session', () => ({
  listChatSessions: vi.fn(() => [{ id: 's1' }]),
  deleteChatSession: vi.fn()
}))
vi.mock('../../agent/permission/broker', () => ({ clearSessionAllowlist: vi.fn() }))
// generateTitle still lives in runtime-singleton until Task 6 moves it to title.ts.
// Mock it so the test does not pull in electron-store via runtime-singleton.
vi.mock('../../agent/runtime-singleton', () => ({ generateTitle: vi.fn(() => 'title') }))

import { registerAgentChatIpc } from '../agent-chat'
import { IpcChannels } from '@shared/ipc-channels'

describe('agent-chat ipc (gateway)', () => {
  beforeEach(() => { handlers.clear(); gw.switchSession.mockClear(); gw.send.mockClear() })

  it('send switches session then sends text via gateway', () => {
    registerAgentChatIpc()
    handlers.get(IpcChannels.agentChat.send)!({}, { chatId: 'c1', text: 'hi' })
    expect(gw.switchSession).toHaveBeenCalledWith('c1')
    expect(gw.send).toHaveBeenCalledWith('hi', undefined)
  })

  it('listSessions reads local sqlite', () => {
    registerAgentChatIpc()
    const r = handlers.get(IpcChannels.agentChat.listSessions)!()
    expect(r).toEqual([{ id: 's1' }])
  })

  it('init returns success', () => {
    registerAgentChatIpc()
    const r = handlers.get(IpcChannels.agentChat.init)!({}, {})
    expect(r).toEqual({ success: true })
  })
})
