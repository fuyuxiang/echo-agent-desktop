import { describe, it, expect, vi, beforeEach } from 'vitest'

let eventHandler: ((ev: Record<string, unknown>) => void) | null = null
const send = vi.fn()
const getMessages = vi.fn()
beforeEach(() => {
  send.mockClear()
  getMessages.mockReset()
  getMessages.mockResolvedValue([])
  eventHandler = null
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      db: {
        session: {
          getMessages
        }
      },
      agentChat: {
        send,
        abort: vi.fn(),
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
  it('sendMessage 转 agentChat.send(当前 chatId)', async () => {
    const ws = await load()
    ws.connect('', 'c1')
    ws.sendMessage('hi')
    expect(send).toHaveBeenCalledWith('c1', 'hi', undefined)
  })

  it('agent:chat:event streaming → 重 emit message.streaming', async () => {
    const ws = await load()
    ws.connect('', 'c1')
    const got: unknown[] = []
    ws.on('message.streaming', (p) => got.push(p))
    eventHandler!({ type: 'streaming', chatId: 'c1', delta: 'Hel', phase: 'text' })
    expect(got.length).toBe(1)
  })

  it('memory_retrieved progress 透传到 message.progress', async () => {
    const ws = await load()
    ws.connect('', 'c1')
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

  it('switchSession 加载历史消息并 emit history.loaded', async () => {
    getMessages.mockResolvedValue([
      { id: 1, chatId: 'c2', role: 'user', content: 'hello', reasoning: null, createdAt: 1000 },
      { id: 2, chatId: 'c2', role: 'assistant', content: 'hi there', reasoning: 'thinking...', createdAt: 1001 }
    ])
    const ws = await load()
    ws.connect('', 'c1')
    const got: Array<Record<string, unknown>> = []
    ws.on('history.loaded', (p) => got.push(p))
    await ws.switchSession('c2')
    expect(getMessages).toHaveBeenCalledWith('c2')
    expect(got.length).toBe(2)
    expect(got[0].role).toBe('user')
    expect(got[0].content).toBe('hello')
    expect(got[1].role).toBe('assistant')
    expect(got[1].reasoning).toBe('thinking...')
  })

  it('switchSession DB 读取失败时不抛异常', async () => {
    getMessages.mockRejectedValue(new Error('db error'))
    const ws = await load()
    ws.connect('', 'c1')
    // Should not throw
    await ws.switchSession('c3')
  })
})
