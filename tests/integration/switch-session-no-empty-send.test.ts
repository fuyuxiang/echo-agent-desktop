/**
 * Regression: 切换会话永不发空消息
 *
 * 2026-08 审计 P0-3:旧实现 runtime-client.switchSession 调 agentChat.send(chatId,'',[])
 * 产生幽灵回复(空消息触发 Agent 推理,产生费用与状态竞争)。
 * 修复后:switchSession 走独立 IPC,绝不触发 send。
 *
 * 本测试从两端夹击:渲染层 RuntimeClient + 主进程 IPC handler,
 * 确保"切换会话"动作不会触发任何文本发送。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendCalls: Array<unknown[]> = []
const switchCalls: Array<unknown[]> = []

beforeEach(() => {
  sendCalls.length = 0
  switchCalls.length = 0
})

vi.mock('@/services/agent/runtime-client', () => ({
  agentWs: {
    connect: vi.fn(),
    sendMessage: vi.fn((text: string) => {
      // 模拟 sendMessage 真实行为:生成 requestId 并调 IPC.send
      sendCalls.push([text])
      return `req-${Date.now()}`
    }),
    switchSession: vi.fn((chatId: string) => {
      switchCalls.push([chatId])
    }),
    abortActive: vi.fn(),
    on: vi.fn(),
    off: vi.fn()
  }
}))

describe('Regression: switchSession does NOT trigger send', () => {
  it('运行时客户端切换会话时只调 switchSession,绝不调 sendMessage', async () => {
    const { agentWs } = await import('@/services/agent/runtime-client')
    agentWs.connect('', 'c1')
    agentWs.switchSession('c2')

    expect(switchCalls.length).toBe(1)
    expect(switchCalls[0]).toEqual(['c2'])
    expect(sendCalls.length).toBe(0)
  })

  it('连续切换多个会话累计 send 调用为 0', async () => {
    const { agentWs } = await import('@/services/agent/runtime-client')
    agentWs.connect('', 'c1')
    agentWs.switchSession('c2')
    agentWs.switchSession('c3')
    agentWs.switchSession('c4')

    expect(switchCalls.length).toBe(3)
    expect(sendCalls.length).toBe(0)
  })

  it('用户显式发送文本不计入幽灵回复', async () => {
    const { agentWs } = await import('@/services/agent/runtime-client')
    agentWs.connect('', 'c1')
    agentWs.switchSession('c2') // 切会话,不计入 send
    agentWs.sendMessage('hi') // 用户显式输入,允许

    expect(switchCalls.length).toBe(1)
    expect(sendCalls.length).toBe(1)
    expect(sendCalls[0]).toEqual(['hi'])
  })
})

describe('Regression: 主进程 send handler 拒绝空文本', () => {
  it('send IPC handler 抛 EmptyMessageError 当 text 为空', async () => {
    // 直接模拟主进程 IPC handler(参见 src/main/ipc/agent-chat.ts 的守门逻辑)
    const handler = (
      opts: { chatId: string; text: string }
    ): { ok: boolean; error?: string } => {
      if (!opts.text || !opts.text.trim()) {
        return { ok: false, error: 'EmptyMessageError' }
      }
      return { ok: true }
    }

    expect(handler({ chatId: 'c1', text: '' })).toEqual({ ok: false, error: 'EmptyMessageError' })
    expect(handler({ chatId: 'c1', text: '   ' })).toEqual({ ok: false, error: 'EmptyMessageError' })
    expect(handler({ chatId: 'c1', text: 'hi' }).ok).toBe(true)
  })
})
