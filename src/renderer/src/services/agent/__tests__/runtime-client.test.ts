import { describe, it, expect, vi, beforeEach } from 'vitest'

let eventHandler: ((ev: Record<string, unknown>) => void) | null = null
const send = vi.fn()
beforeEach(() => {
  send.mockClear()
  eventHandler = null
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
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
})
