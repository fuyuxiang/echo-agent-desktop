import { describe, it, expect, vi, beforeEach } from 'vitest'

let eventHandler: ((ev: Record<string, unknown>) => void) | null = null
const send = vi.fn()
const switchSession = vi.fn()
const abort = vi.fn()
beforeEach(() => {
  send.mockClear()
  switchSession.mockClear()
  abort.mockClear()
  eventHandler = null
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      agentChat: {
        send,
        switchSession,
        abort,
        listSessions: vi.fn(),
        deleteSession: vi.fn(),
        onEvent: (h: (ev: Record<string, unknown>) => void) => {
          eventHandler = h
          return () => {}
        }
      }
    }
  }
})

async function load() {
  vi.resetModules()
  return (await import('../runtime-client')).agentWs
}

describe('runtime-client agentWs', () => {
  it('sendMessage 转 agentChat.send(当前 chatId + requestId)', async () => {
    const ws = await load()
    ws.connect('', 'c1')
    const rid = ws.sendMessage('hi')
    expect(rid).toMatch(/^req-/)
    expect(send).toHaveBeenCalledWith('c1', 'hi', undefined, rid)
  })

  it('agent:chat:event streaming → 重 emit message.streaming', async () => {
    const ws = await load()
    ws.connect('', 'c1')
    // 必须有 activeRequestId 才能路由(否则 requestId 路由兜底到 chatId)
    ws.sendMessage('hi')
    const got: unknown[] = []
    ws.on('message.streaming', (p) => got.push(p))
    eventHandler!({ type: 'streaming', chatId: 'c1', delta: 'Hel', phase: 'text' })
    expect(got.length).toBe(1)
  })

  it('memory_retrieved progress 透传到 message.progress', async () => {
    const ws = await load()
    ws.connect('', 'c1')
    ws.sendMessage('hi') // 触发 activeRequestId
    const got: Array<Record<string, unknown>> = []
    ws.on('message.progress', (p) => got.push(p))
    eventHandler!({
      type: 'progress',
      chatId: 'c1',
      progressType: 'memory_retrieved',
      hits: [{ id: '1', text: 'x', score: 0.9 }]
    })
    expect(got[0].progressType).toBe('memory_retrieved')
  })

  it('route 过滤不同 chatId 的事件', async () => {
    const ws = await load()
    ws.connect('', 'c1')
    const got: unknown[] = []
    ws.on('message.streaming', (p) => got.push(p))
    eventHandler!({ type: 'streaming', chatId: 'c2', delta: 'Leak', phase: 'text' })
    expect(got.length).toBe(0)
  })

  it('memory-candidate 事件重 emit 到 memory-candidate 通道', async () => {
    const ws = await load()
    ws.connect('', 'c1')
    ws.sendMessage('hi')
    const got: Array<Record<string, unknown>> = []
    ws.on('memory-candidate', (p) => got.push(p))
    eventHandler!({
      type: 'memory-candidate',
      chatId: 'c1',
      content: '团队约定每周一晨会',
      tags: ['convention'],
      reason: '多次出现,值得共享'
    })
    expect(got).toHaveLength(1)
    expect(got[0].content).toBe('团队约定每周一晨会')
    expect(got[0].tags).toEqual(['convention'])
    expect(got[0].reason).toBe('多次出现,值得共享')
  })

  it('switchSession 调用独立 switchSession IPC,绝不触发 send', async () => {
    const ws = await load()
    ws.connect('', 'c1')
    await ws.switchSession('c2')
    expect(switchSession).toHaveBeenCalledWith('c2')
    expect(send).not.toHaveBeenCalled()
  })

  it('switchSession send 失败时不抛异常(现在改测 switchSession 失败)', async () => {
    switchSession.mockRejectedValueOnce(new Error('switch failed'))
    const ws = await load()
    ws.connect('', 'c1')
    // Should not throw
    await ws.switchSession('c3')
  })

  it('Regression: 切换会话永不发空消息', async () => {
    const ws = await load()
    ws.connect('', 'c1')
    await ws.switchSession('c2')
    // 任何包含空 text 的 send 调用都是 bug
    const calls = send.mock.calls
    for (const c of calls) {
      expect(c[1]).not.toBe('') // text 不为空
    }
    expect(calls.find((c) => c[0] === 'c2' && (c[1] === '' || c[1] === undefined))).toBeUndefined()
  })

  it('Regression: 流式 chunk 按 requestId 路由,不匹配的丢弃', async () => {
    const ws = await load()
    ws.connect('', 'c1')
    const rid = ws.sendMessage('hi')
    const got: unknown[] = []
    ws.on('message.streaming', (p) => got.push(p))

    // 同 chatId 但不同 requestId 的 chunk 应该被丢弃(切换会话的边缘情况)
    eventHandler!({ type: 'streaming', chatId: 'c1', request_id: 'req-other', delta: 'A' })
    // 匹配的 chunk 应该被路由
    eventHandler!({ type: 'streaming', chatId: 'c1', request_id: rid, delta: 'B' })
    expect(got.length).toBe(1)
    expect((got[0] as { delta: string }).delta).toBe('B')
  })

  it('Regression: 切换会话后旧 requestId 的 chunk 静默丢弃', async () => {
    const ws = await load()
    ws.connect('', 'c1')
    const oldRid = ws.sendMessage('hi')
    const got: unknown[] = []
    ws.on('message.streaming', (p) => got.push(p))

    // 切换会话
    await ws.switchSession('c2')

    // 旧 rid 的 chunk 到达 — 应被丢弃
    eventHandler!({ type: 'streaming', chatId: 'c1', request_id: oldRid, delta: 'LATE' })
    expect(got.length).toBe(0)
  })

  it('Regression: abortActive 调后端 abort 并清空 activeRequestId', async () => {
    const ws = await load()
    ws.connect('', 'c1')
    ws.sendMessage('hi')
    ws.abortActive()
    expect(abort).toHaveBeenCalledWith('c1', expect.stringMatching(/^req-/))
    expect(ws.currentRequestId).toBe('')
  })
})
