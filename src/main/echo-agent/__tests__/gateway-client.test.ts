import { describe, it, expect, vi } from 'vitest'
import { translateFrame, GatewayClient, type WsLike, type Frame } from '../gateway-client'

// importing ../index pulls in electron-log/main, which is not usable in tests
vi.mock('electron-log/main', () => ({ default: { info() {}, warn() {}, error() {} } }))
import { buildWsUrl } from '../index'

function fakeWs(): WsLike & { fire: (ev: string, arg?: unknown) => void; sent: string[] } {
  const handlers: Record<string, (arg?: unknown) => void> = {}
  const sent: string[] = []
  return {
    send: (d: string) => sent.push(d),
    close: () => {},
    on: (ev, cb) => { handlers[ev] = cb },
    fire: (ev, arg) => handlers[ev]?.(arg),
    sent,
    readyState: 1 // WebSocket.OPEN
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

  it('schedules a reconnect via scheduleReconnect on unexpected close', () => {
    let created = 0
    const scheduled: Array<() => void> = []
    const wss: ReturnType<typeof fakeWs>[] = []
    const c = new GatewayClient({
      wsUrl: 'ws://x/ws', token: 't',
      createWs: () => { created++; const w = fakeWs(); wss.push(w); return w },
      emit: () => {},
      scheduleReconnect: (fn) => { scheduled.push(fn) }
    })
    c.connect('c1')
    wss[0].fire('open')
    wss[0].fire('close')
    expect(created).toBe(1)        // not reconnected synchronously
    expect(scheduled).toHaveLength(1)
    scheduled[0]()                 // run the scheduled reconnect
    expect(created).toBe(2)
  })

  it('stops reconnecting after maxReconnects and emits an error', () => {
    let created = 0
    const events: Frame[] = []
    const wss: ReturnType<typeof fakeWs>[] = []
    const c = new GatewayClient({
      wsUrl: 'ws://x/ws', token: 't',
      createWs: () => { created++; const w = fakeWs(); wss.push(w); return w },
      emit: (e) => events.push(e),
      scheduleReconnect: (fn) => fn(),   // run reconnect synchronously
      maxReconnects: 3
    })
    c.connect('c1')
    // each unexpected close triggers one reconnect until the cap is hit
    for (let i = 0; i < 5; i++) {
      wss[wss.length - 1].fire('open')
      wss[wss.length - 1].fire('close')
    }
    expect(created).toBe(1 + 3)   // initial + 3 reconnects
    expect(events.some((e) => e.type === 'error')).toBe(true)
  })

  it('a deliberate connect() restores reconnect ability after the budget is exhausted', () => {
    let created = 0
    const wss: ReturnType<typeof fakeWs>[] = []
    const c = new GatewayClient({
      wsUrl: 'ws://x/ws', token: 't',
      createWs: () => { created++; const w = fakeWs(); wss.push(w); return w },
      emit: () => {},
      scheduleReconnect: (fn) => fn(),
      maxReconnects: 2
    })
    c.connect('c1')
    for (let i = 0; i < 4; i++) {
      wss[wss.length - 1].fire('open')
      wss[wss.length - 1].fire('close')
    }
    expect(created).toBe(1 + 2)   // budget exhausted (initial + 2 reconnects)
    // caller deliberately reconnects → budget reset, auto-reconnect works again
    c.connect('c1')
    expect(created).toBe(4)
    wss[wss.length - 1].fire('open')
    wss[wss.length - 1].fire('close')
    expect(created).toBe(5)
  })

  it('self-heals: a send() after the reconnect budget is exhausted rebuilds the connection and flushes', () => {
    let created = 0
    const wss: ReturnType<typeof fakeWs>[] = []
    const c = new GatewayClient({
      wsUrl: 'ws://x/ws', token: 't',
      createWs: () => { created++; const w = fakeWs(); wss.push(w); return w },
      emit: () => {},
      scheduleReconnect: (fn) => fn(),
      maxReconnects: 1
    })
    c.connect('c1')
    // exhaust the budget: initial + 1 reconnect, then give up (ws dropped)
    wss[wss.length - 1].fire('open')
    wss[wss.length - 1].fire('close') // reconnect 1
    wss[wss.length - 1].fire('open')
    wss[wss.length - 1].fire('close') // give up → ws = null
    expect(created).toBe(2)

    // ① a new send re-establishes the connection instead of buffering forever
    c.send('after-giveup')
    expect(created).toBe(3)
    const fresh = wss[wss.length - 1]
    fresh.fire('open')
    const auth = JSON.parse(fresh.sent[0])
    expect(auth).toMatchObject({ type: 'auth', chat_id: 'c1' })

    // ② after auth_ok the buffered message flushes over the rebuilt connection
    fresh.fire('message', JSON.stringify({ type: 'auth_ok', session_key: 'k' }))
    const msg = JSON.parse(fresh.sent[1])
    expect(msg).toMatchObject({ type: 'message', text: 'after-giveup' })
  })

  it('resets reconnect attempts after auth_ok so a later close can reconnect again', () => {
    let created = 0
    const wss: ReturnType<typeof fakeWs>[] = []
    const c = new GatewayClient({
      wsUrl: 'ws://x/ws', token: 't',
      createWs: () => { created++; const w = fakeWs(); wss.push(w); return w },
      emit: () => {},
      scheduleReconnect: (fn) => fn(),
      maxReconnects: 2
    })
    c.connect('c1')
    // exhaust the budget with two reconnects (no auth_ok in between)
    wss[wss.length - 1].fire('open')
    wss[wss.length - 1].fire('close') // reconnect 1
    wss[wss.length - 1].fire('open')
    wss[wss.length - 1].fire('close') // reconnect 2
    expect(created).toBe(3)           // capped at initial + 2
    // now a successful auth resets the counter
    wss[wss.length - 1].fire('open')
    wss[wss.length - 1].fire('message', JSON.stringify({ type: 'auth_ok', session_key: 'k' }))
    wss[wss.length - 1].fire('close')
    expect(created).toBe(4)           // attempts reset → reconnect happens again
  })

  it('does not reconnect after explicit disconnect', () => {
    let created = 0
    const wss: ReturnType<typeof fakeWs>[] = []
    const c = new GatewayClient({
      wsUrl: 'ws://x/ws', token: 't',
      createWs: () => { created++; const w = fakeWs(); wss.push(w); return w },
      emit: () => {},
      scheduleReconnect: (fn) => fn()
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

  it('switchSession before auth_ok keeps emitting under the new chatId once authed', () => {
    const ws = fakeWs()
    const events: Frame[] = []
    const c = new GatewayClient({ wsUrl: 'ws://x/ws', token: 't', createWs: () => ws, emit: (e) => events.push(e) })
    c.connect('c1')
    ws.fire('open')              // auth sent for c1, but not yet authed
    c.switchSession('c2')        // ws present but not authed → no extra auth, chatId becomes c2
    expect(ws.sent).toHaveLength(1)
    ws.fire('message', JSON.stringify({ type: 'auth_ok', session_key: 'k' }))
    ws.fire('message', JSON.stringify({ type: 'message', text: 'hi', is_final: true }))
    expect(events[0]).toMatchObject({ type: 'final', chatId: 'c2' })
  })

  it('abort(chatId) sends abort frame when WS is open', () => {
    const ws = fakeWs()
    const c = new GatewayClient({ wsUrl: 'ws://x/ws', token: 't', createWs: () => ws, emit: () => {} })
    c.connect('c1')
    ws.fire('open')
    ws.fire('message', JSON.stringify({ type: 'auth_ok', session_key: 'k' }))
    c.send('hello')              // creates an active request for c1
    c.abort('c1')
    const abortFrame = JSON.parse(ws.sent[ws.sent.length - 1])
    expect(abortFrame).toMatchObject({ type: 'abort', chatId: 'c1' })
  })

  it('abort(chatId) is a no-op when chatId has no active request', () => {
    const ws = fakeWs()
    const c = new GatewayClient({ wsUrl: 'ws://x/ws', token: 't', createWs: () => ws, emit: () => {} })
    c.connect('c1')
    ws.fire('open')
    ws.fire('message', JSON.stringify({ type: 'auth_ok', session_key: 'k' }))
    const sentBefore = ws.sent.length
    c.abort('nonexistent')
    // Only the abort frame should be sent (if ws is open), but no crash
    const sentAfter = ws.sent.length
    expect(sentAfter).toBe(sentBefore + 1) // abort frame sent since ws is open
    const abortFrame = JSON.parse(ws.sent[sentAfter - 1])
    expect(abortFrame).toMatchObject({ type: 'abort', chatId: 'nonexistent' })
  })

  it('activeRequests is cleaned up after done event', () => {
    const ws = fakeWs()
    const events: Frame[] = []
    const c = new GatewayClient({ wsUrl: 'ws://x/ws', token: 't', createWs: () => ws, emit: (e) => events.push(e) })
    c.connect('c1')
    ws.fire('open')
    ws.fire('message', JSON.stringify({ type: 'auth_ok', session_key: 'k' }))
    c.send('hello')
    // send() creates an active request
    expect((c as any).activeRequests.has('c1')).toBe(true)
    ws.fire('message', JSON.stringify({ type: 'message', text: 'done', is_final: true, message_kind: 'final' }))
    // After done event, activeRequests should be cleaned up
    expect((c as any).activeRequests.has('c1')).toBe(false)
  })

  it('activeRequests is cleaned up after error event', () => {
    const ws = fakeWs()
    const events: Frame[] = []
    const c = new GatewayClient({ wsUrl: 'ws://x/ws', token: 't', createWs: () => ws, emit: (e) => events.push(e) })
    c.connect('c1')
    ws.fire('open')
    ws.fire('message', JSON.stringify({ type: 'auth_ok', session_key: 'k' }))
    c.send('hello')
    expect((c as any).activeRequests.has('c1')).toBe(true)
    ws.fire('message', JSON.stringify({ type: 'error', error: 'something went wrong' }))
    expect((c as any).activeRequests.has('c1')).toBe(false)
  })

  it('abort suppresses subsequent events for the aborted request', () => {
    const ws = fakeWs()
    const events: Frame[] = []
    const c = new GatewayClient({ wsUrl: 'ws://x/ws', token: 't', createWs: () => ws, emit: (e) => events.push(e) })
    c.connect('c1')
    ws.fire('open')
    ws.fire('message', JSON.stringify({ type: 'auth_ok', session_key: 'k' }))
    c.send('hello')
    c.abort('c1')
    // After abort, further message frames should be suppressed
    ws.fire('message', JSON.stringify({ type: 'message', text: 'late chunk', is_final: false }))
    // No new events should have been emitted (only the abort-related ones)
    expect(events).toHaveLength(0)
  })

  it('disconnect() aborts all active requests', () => {
    const ws = fakeWs()
    const c = new GatewayClient({ wsUrl: 'ws://x/ws', token: 't', createWs: () => ws, emit: () => {} })
    c.connect('c1')
    ws.fire('open')
    ws.fire('message', JSON.stringify({ type: 'auth_ok', session_key: 'k' }))
    c.send('hello')
    expect((c as any).activeRequests.size).toBeGreaterThan(0)
    c.disconnect()
    expect((c as any).activeRequests.size).toBe(0)
  })
})

describe('buildWsUrl', () => {
  it('converts http base + default ws path to ws url', () => {
    expect(buildWsUrl('http://127.0.0.1:51234')).toBe('ws://127.0.0.1:51234/ws')
  })
  it('honours a custom ws path', () => {
    expect(buildWsUrl('http://127.0.0.1:8', '/socket')).toBe('ws://127.0.0.1:8/socket')
  })
})
