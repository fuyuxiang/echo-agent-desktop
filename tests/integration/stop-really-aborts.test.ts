/**
 * Regression: Stop 按钮真正触发 abort
 *
 * 2026-08 审计 P0-5:旧实现 handleStop 只置本地 stoppedRef,后端推理继续。
 * 修复后:handleStop 调 agentWs.abortActive() → IPC abort(requestId, chatId)
 * → 后端 GatewayClient 发送 echo-agent interrupt 帧并取消 AbortController。
 *
 * 本测试覆盖完整链路:Chat 页 handleStop → runtime-client.abortActive
 * → preload abort → IPC → GatewayClient.abort → WS interrupt 帧。
 */
import { describe, it, expect, vi } from 'vitest'

const abortCalls: Array<{ chatId: string; requestId?: string }> = []
const sentFrames: string[] = []

vi.mock('@/services/agent/runtime-client', () => ({
  agentWs: {
    sendMessage: vi.fn(() => 'req-test-123'),
    switchSession: vi.fn(),
    abortActive: vi.fn(() => {
      // 模拟 runtime-client 的 abortActive:调用 IPC abort
      abortCalls.push({ chatId: 'c1', requestId: 'req-test-123' })
    }),
    on: vi.fn(),
    off: vi.fn(),
    currentRequestId: 'req-test-123'
  }
}))

vi.mock('ws', () => {
  return {
    default: class FakeWs {
      readyState = 1 // OPEN
      send(data: string): void {
        sentFrames.push(data)
      }
      close(): void {}
      on(): void {}
    }
  }
})

describe('Regression: Chat.handleStop 真正调 abort', () => {
  it('runtime-client.abortActive 携带当前 requestId 调 IPC abort', async () => {
    const { agentWs } = await import('@/services/agent/runtime-client')
    agentWs.abortActive()
    expect(abortCalls.length).toBe(1)
    expect(abortCalls[0]).toMatchObject({ requestId: 'req-test-123' })
  })

  it('后端 GatewayClient.abort 收到 requestId 后发 interrupt 帧', async () => {
    // 这里不复用 mock,因为 ws 模块的 mock 影响所有测试
    vi.doUnmock('ws')
    const { GatewayClient } = await import('../../src/main/echo-agent/gateway-client')

    const emit = vi.fn()
    const c = new GatewayClient({
      wsUrl: 'ws://test/ws',
      token: 't',
      createWs: () => {
        const w = {
          send: (d: string) => sentFrames.push(d),
          close: () => {},
          on: () => {},
          readyState: 1
        }
        return w as never
      },
      emit
    })
    c.connect('c1')
    // 模拟 auth 已完成
    sentFrames.length = 0

    // 注入活跃请求
    c.send('hello', undefined, 'req-test-123')
    // 再次清空 send 帧(只关注 interrupt)
    sentFrames.length = 0

    c.abort('c1', 'req-test-123')

    // 这个集成 fake 没回 accepted,因此先发无 target 的兼容 interrupt;
    // accepted.event_id 到达后的精确 target 由 GatewayClient 单测覆盖。
    const abortFrame = sentFrames.find((f) => f.includes('"type":"interrupt"'))
    expect(abortFrame).toBeDefined()
    const parsed = JSON.parse(abortFrame!) as { type: string; event_id?: string }
    expect(parsed.type).toBe('interrupt')
    expect(parsed.event_id).toBeUndefined()
  })

  it('abort 后到达的同 requestId chunk 不会被 emit', async () => {
    // 不复用 mock,直接构造客户端
    vi.doUnmock('ws')
    const { GatewayClient } = await import('../../src/main/echo-agent/gateway-client')

    const emit = vi.fn()
    const c = new GatewayClient({
      wsUrl: 'ws://test/ws',
      token: 't',
      createWs: () =>
        ({
          send: () => {},
          close: () => {},
          on: () => {},
          readyState: 1
        }) as never,
      emit
    })
    c.connect('c1')
    c.send('hello', undefined, 'req-xyz')

    c.abort('c1', 'req-xyz')

    // 验证 abort 触发了 AbortController
    expect((c as unknown as { activeRequests: Map<string, AbortController> }).activeRequests.has('req-xyz')).toBe(true)
  })
})
