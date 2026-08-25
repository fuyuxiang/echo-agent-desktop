import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
const winSend = vi.fn()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: winSend } }] }
}))

const gw = {
  switchSession: vi.fn(),
  send: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  abort: vi.fn()
}
const getGatewayClient = vi.fn<(...a: unknown[]) => typeof gw | null>(() => gw)
vi.mock('../../echo-agent', () => ({
  getGatewayClient: (...a: unknown[]) => getGatewayClient(...a),
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
  beforeEach(() => {
    handlers.clear()
    gw.switchSession.mockClear()
    gw.send.mockClear()
    winSend.mockClear()
    getGatewayClient.mockClear()
    getGatewayClient.mockReturnValue(gw)
  })

  it('send 仅通过 gateway 发送文本,不再耦合 switchSession', () => {
    registerAgentChatIpc()
    handlers.get(IpcChannels.agentChat.send)!({}, { chatId: 'c1', text: 'hi' })
    expect(gw.send).toHaveBeenCalledWith('hi', undefined, undefined)
    expect(gw.switchSession).not.toHaveBeenCalled()
  })

  it('Regression: send 拒绝空文本(不允许幽灵回复)', () => {
    registerAgentChatIpc()
    const handler = handlers.get(IpcChannels.agentChat.send)!
    expect(() => handler({}, { chatId: 'c1', text: '' })).toThrow()
    expect(() => handler({}, { chatId: 'c1', text: '   ' })).toThrow()
    expect(gw.send).not.toHaveBeenCalled()
  })

  it('switchSession 仅调用 gateway.switchSession', () => {
    registerAgentChatIpc()
    handlers.get(IpcChannels.agentChat.switchSession)!({}, { chatId: 'c2' })
    expect(gw.switchSession).toHaveBeenCalledWith('c2')
    expect(gw.send).not.toHaveBeenCalled()
  })

  it('send broadcasts error when gateway client is unavailable', () => {
    getGatewayClient.mockReturnValueOnce(null)
    registerAgentChatIpc()
    handlers.get(IpcChannels.agentChat.send)!({}, { chatId: 'c1', text: 'hi' })
    expect(gw.send).not.toHaveBeenCalled()
    expect(winSend).toHaveBeenCalledWith(
      IpcChannels.agentChat.event,
      expect.objectContaining({ type: 'error', chatId: 'c1', message: expect.stringContaining('未就绪') })
    )
  })

  it('listSessions reads local sqlite', () => {
    registerAgentChatIpc()
    const r = handlers.get(IpcChannels.agentChat.listSessions)!()
    expect(r).toEqual([{ id: 's1' }])
  })

  it('init returns success and ensures gateway client', () => {
    registerAgentChatIpc()
    const r = handlers.get(IpcChannels.agentChat.init)!({}, {})
    expect(r).toEqual({ success: true })
    expect(getGatewayClient).toHaveBeenCalled()
  })

  it('sendSkillList 把 requestId 打进 skill.list 帧 JSON 整体透传给 gateway.send', () => {
    registerAgentChatIpc()
    handlers.get(IpcChannels.agentChat.sendSkillList)!({}, { requestId: 'skill-abc' })
    expect(gw.send).toHaveBeenCalledTimes(1)
    const frame = gw.send.mock.calls[0][0] as string
    expect(typeof frame).toBe('string')
    expect(JSON.parse(frame)).toEqual({ type: 'skill.list', request_id: 'skill-abc' })
  })

  it('sendSkillEnable 把 name + requestId 打进 skill.enable 帧,不能错放 attachments', () => {
    registerAgentChatIpc()
    handlers.get(IpcChannels.agentChat.sendSkillEnable)!({}, {
      name: 'ppt-author',
      requestId: 'skill-xyz'
    })
    expect(gw.send).toHaveBeenCalledTimes(1)
    const frame = gw.send.mock.calls[0][0] as string
    expect(JSON.parse(frame)).toEqual({
      type: 'skill.enable',
      name: 'ppt-author',
      request_id: 'skill-xyz'
    })
    // 守门:name 必须进帧 body,不能漏到第二个参数(attachments)
    expect(gw.send.mock.calls[0][1]).toBeUndefined()
    expect(gw.send.mock.calls[0][2]).toBeUndefined()
  })

  it('sendSkillDisable 把 name + requestId 打进 skill.disable 帧', () => {
    registerAgentChatIpc()
    handlers.get(IpcChannels.agentChat.sendSkillDisable)!({}, {
      name: 'memo-recorder',
      requestId: 'skill-def'
    })
    expect(gw.send).toHaveBeenCalledTimes(1)
    const frame = gw.send.mock.calls[0][0] as string
    expect(JSON.parse(frame)).toEqual({
      type: 'skill.disable',
      name: 'memo-recorder',
      request_id: 'skill-def'
    })
    expect(gw.send.mock.calls[0][1]).toBeUndefined()
    expect(gw.send.mock.calls[0][2]).toBeUndefined()
  })

  it('skill IPC handler 在 gateway 不可用时广播 error 帧,带原 request_id', () => {
    getGatewayClient.mockReturnValueOnce(null)
    registerAgentChatIpc()
    handlers.get(IpcChannels.agentChat.sendSkillEnable)!({}, {
      name: 'ppt-author',
      requestId: 'skill-nop'
    })
    expect(gw.send).not.toHaveBeenCalled()
    expect(winSend).toHaveBeenCalledWith(
      IpcChannels.agentChat.event,
      expect.objectContaining({
        type: 'error',
        request_id: 'skill-nop',
        message: expect.stringContaining('未就绪')
      })
    )
  })
})
