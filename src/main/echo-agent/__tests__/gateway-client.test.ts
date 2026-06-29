import { describe, it, expect } from 'vitest'
import { translateFrame, GatewayClient, type WsLike, type Frame } from '../gateway-client'

function fakeWs(): WsLike & { fire: (ev: string, arg?: unknown) => void; sent: string[] } {
  const handlers: Record<string, (arg?: unknown) => void> = {}
  const sent: string[] = []
  return {
    send: (d: string) => sent.push(d),
    close: () => {},
    on: (ev, cb) => { handlers[ev] = cb },
    fire: (ev, arg) => handlers[ev]?.(arg),
    sent
  }
}

describe('translateFrame', () => {
  it('control frames produce no events', () => {
    expect(translateFrame({ type: 'auth_ok', session_key: 'k' }, 'c1')).toEqual([])
    expect(translateFrame({ type: 'accepted', event_id: 'e1' }, 'c1')).toEqual([])
    expect(translateFrame({ type: 'pong' }, 'c1')).toEqual([])
  })

  it('final message yields final + done, preserving text and chatId', () => {
    const out = translateFrame(
      { type: 'message', text: '你好', is_final: true, message_kind: 'final', event_id: 'e1' },
      'c1'
    )
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ type: 'final', text: '你好', chatId: 'c1' })
    expect(out[1]).toMatchObject({ type: 'done', chatId: 'c1' })
  })

  it('progress message (message_kind) yields progress preserving metadata', () => {
    const meta = { progress_type: 'tool_call', tool: 'shell' }
    const out = translateFrame(
      { type: 'message', text: '', is_final: false, message_kind: 'progress', metadata: meta },
      'c1'
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ type: 'progress', chatId: 'c1' })
    expect(out[0].metadata).toEqual(meta)
  })

  it('progress via metadata._progress flag also maps to progress', () => {
    const out = translateFrame(
      { type: 'message', text: '', is_final: false, metadata: { _progress: true } },
      'c1'
    )
    expect(out[0]).toMatchObject({ type: 'progress' })
  })

  it('non-final non-progress text maps to streaming', () => {
    const out = translateFrame(
      { type: 'message', text: 'partial', is_final: false }, 'c1'
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ type: 'streaming', text: 'partial', chatId: 'c1' })
  })

  it('error frame maps to error preserving message', () => {
    const out = translateFrame({ type: 'error', error: 'unauthorized' }, 'c1')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ type: 'error', chatId: 'c1' })
    expect(out[0].message ?? out[0].error).toBe('unauthorized')
  })

  it('final message with error:null is not treated as error', () => {
    const out = translateFrame(
      { type: 'message', text: 'x', is_final: true, error: null }, 'c1'
    )
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ type: 'final', text: 'x', chatId: 'c1' })
    expect(out[1]).toMatchObject({ type: 'done', chatId: 'c1' })
  })

  it('control frame with empty error string is not treated as error', () => {
    expect(translateFrame({ type: 'auth_ok', error: '' }, 'c1')).toEqual([])
  })
})

describe('GatewayClient', () => {
  it('sends auth frame on open with chatId and token', () => {
    const ws = fakeWs()
    const c = new GatewayClient({ wsUrl: 'ws://x/ws', token: 'tok', createWs: () => ws, emit: () => {} })
    c.connect('chat-1')
    ws.fire('open')
    const auth = JSON.parse(ws.sent[0])
    expect(auth).toMatchObject({ type: 'auth', chat_id: 'chat-1', token: 'tok', platform: 'desktop' })
  })

  it('buffers a message sent before auth_ok and flushes after', () => {
    const ws = fakeWs()
    const c = new GatewayClient({ wsUrl: 'ws://x/ws', token: 't', createWs: () => ws, emit: () => {} })
    c.connect('c1')
    ws.fire('open')          // auth sent (sent[0])
    c.send('hello')          // before auth_ok → buffered
    expect(ws.sent).toHaveLength(1)
    ws.fire('message', JSON.stringify({ type: 'auth_ok', session_key: 'gateway:desktop:c1' }))
    const msg = JSON.parse(ws.sent[1])
    expect(msg).toMatchObject({ type: 'message', text: 'hello' })
  })

  it('emits translated events for an inbound message frame', () => {
    const ws = fakeWs()
    const events: Frame[] = []
    const c = new GatewayClient({ wsUrl: 'ws://x/ws', token: 't', createWs: () => ws, emit: (e) => events.push(e) })
    c.connect('c1')
    ws.fire('open')
    ws.fire('message', JSON.stringify({ type: 'auth_ok', session_key: 'k' }))
    ws.fire('message', JSON.stringify({ type: 'message', text: 'hi', is_final: true, message_kind: 'final' }))
    expect(events.map((e) => e.type)).toEqual(['final', 'done'])
    expect(events[0]).toMatchObject({ text: 'hi', chatId: 'c1' })
  })

  it('reconnects once when ws closes unexpectedly', () => {
    let created = 0
    const wss: ReturnType<typeof fakeWs>[] = []
    const c = new GatewayClient({
      wsUrl: 'ws://x/ws', token: 't',
      createWs: () => { created++; const w = fakeWs(); wss.push(w); return w },
      emit: () => {}
    })
    c.connect('c1')
    wss[0].fire('open')
    wss[0].fire('close')
    expect(created).toBe(2) // auto-reconnect created a second ws
  })

  it('does not reconnect after explicit disconnect', () => {
    let created = 0
    const wss: ReturnType<typeof fakeWs>[] = []
    const c = new GatewayClient({
      wsUrl: 'ws://x/ws', token: 't',
      createWs: () => { created++; const w = fakeWs(); wss.push(w); return w },
      emit: () => {}
    })
    c.connect('c1')
    wss[0].fire('open')
    c.disconnect()
    wss[0].fire('close')
    expect(created).toBe(1)
  })

  it('switchSession re-sends auth with the new chatId when authed', () => {
    const ws = fakeWs()
    const c = new GatewayClient({ wsUrl: 'ws://x/ws', token: 't', createWs: () => ws, emit: () => {} })
    c.connect('c1')
    ws.fire('open')
    ws.fire('message', JSON.stringify({ type: 'auth_ok', session_key: 'k' }))
    c.switchSession('c2')
    const auth = JSON.parse(ws.sent[ws.sent.length - 1])
    expect(auth).toMatchObject({ type: 'auth', chat_id: 'c2' })
  })
})
