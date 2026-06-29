export type Frame = Record<string, unknown>

const CONTROL_TYPES = new Set(['auth_ok', 'accepted', 'pong', 'auth'])

export function translateFrame(frame: Frame, chatId: string): Frame[] {
  const type = frame.type as string | undefined

  if (type === 'error' || (frame.error != null && frame.error !== '')) {
    return [{ ...frame, type: 'error', chatId, message: frame.error ?? frame.message }]
  }
  if (type && CONTROL_TYPES.has(type)) {
    return []
  }
  if (type !== 'message') {
    return []
  }

  const meta = (frame.metadata as Record<string, unknown> | undefined) ?? undefined
  const isProgress = frame.message_kind === 'progress' || meta?._progress === true
  if (isProgress) {
    return [{ ...frame, type: 'progress', chatId }]
  }
  if (frame.is_final === true) {
    return [
      { ...frame, type: 'final', chatId },
      { type: 'done', chatId }
    ]
  }
  // non-final, non-progress text → streaming increment
  return [{ ...frame, type: 'streaming', chatId }]
}

export interface WsLike {
  send(data: string): void
  close(): void
  on(ev: 'open' | 'message' | 'close' | 'error', cb: (arg?: unknown) => void): void
}

export interface GatewayClientDeps {
  wsUrl: string
  token: string
  createWs: (url: string) => WsLike
  emit: (event: Frame) => void
  platform?: string
  userId?: string
  // Schedule a reconnect attempt. Default applies a fixed backoff so that a
  // crashing gateway cannot cause an unbounded, no-delay reconnect loop.
  scheduleReconnect?: (fn: () => void) => void
  // Hard cap on consecutive reconnect attempts before giving up.
  maxReconnects?: number
}

const DEFAULT_MAX_RECONNECTS = 5
const RECONNECT_DELAY_MS = 2000

const defaultScheduleReconnect = (fn: () => void): void => {
  const t = setTimeout(fn, RECONNECT_DELAY_MS)
  ;(t as { unref?: () => void }).unref?.()
}

export class GatewayClient {
  private ws: WsLike | null = null
  private chatId = ''
  private authed = false
  private pendingSend: string | null = null
  private closing = false
  private reconnectAttempts = 0

  constructor(private deps: GatewayClientDeps) {}

  connect(chatId: string): void {
    // public, deliberate connection → start with a fresh reconnect budget so a
    // previously exhausted client can recover when the caller asks to reconnect
    this.reconnectAttempts = 0
    this.launch(chatId)
  }

  // wires up a ws for chatId without touching the reconnect budget; shared by
  // connect() and the auto-reconnect path so the max cap is not bypassed
  private launch(chatId: string): void {
    this.chatId = chatId
    this.closing = false
    this.authed = false
    const ws = this.deps.createWs(this.deps.wsUrl)
    this.ws = ws
    ws.on('open', () => this.sendAuth())
    ws.on('message', (data) => this.onFrame(String(data)))
    ws.on('close', () => this.onClose())
    ws.on('error', () => { /* close will follow; reconnect handled there */ })
  }

  switchSession(chatId: string): void {
    // chatId is updated immediately so that, even before auth completes, a
    // later auth_ok and any translated frames bind to the new session.
    this.chatId = chatId
    if (this.ws && this.authed) {
      this.authed = false
      this.sendAuth()
    } else if (!this.ws) {
      this.connect(chatId)
    }
  }

  send(text: string, attachments?: Array<{ id: string; name: string }>): void {
    const frame = JSON.stringify({ type: 'message', text, attachments })
    if (this.ws && this.authed) {
      this.ws.send(frame)
      return
    }
    this.pendingSend = frame
    // self-heal: if the reconnect budget was exhausted (ws was dropped), a new
    // send re-establishes the connection so the buffered frame can flush after
    // auth_ok. connect() resets the reconnect budget.
    if (!this.ws && !this.closing && this.chatId) {
      this.connect(this.chatId)
    }
  }

  disconnect(): void {
    this.closing = true
    this.ws?.close()
    this.ws = null
    this.authed = false
    this.pendingSend = null
  }

  private sendAuth(): void {
    this.ws?.send(JSON.stringify({
      type: 'auth',
      platform: this.deps.platform ?? 'desktop',
      user_id: this.deps.userId ?? 'desktop-user',
      chat_id: this.chatId,
      token: this.deps.token
    }))
  }

  private onFrame(raw: string): void {
    let frame: Frame
    try {
      frame = JSON.parse(raw)
    } catch {
      return
    }
    if (frame.type === 'auth_ok') {
      this.authed = true
      // a successful handshake means the connection is healthy again
      this.reconnectAttempts = 0
      if (this.pendingSend) {
        this.ws?.send(this.pendingSend)
        this.pendingSend = null
      }
      return
    }
    for (const ev of translateFrame(frame, this.chatId)) {
      this.deps.emit(ev)
    }
  }

  private onClose(): void {
    this.authed = false
    if (this.closing) return
    const max = this.deps.maxReconnects ?? DEFAULT_MAX_RECONNECTS
    if (this.reconnectAttempts >= max) {
      // give up rather than hammering a persistently broken gateway
      this.deps.emit({
        type: 'error',
        chatId: this.chatId,
        message: 'gateway 连接已断开,重连失败'
      })
      // drop the dead ws but keep closing=false so a later send() can self-heal
      // via switchSession()/connect() and reset the reconnect budget
      this.ws?.close()
      this.ws = null
      return
    }
    this.reconnectAttempts++
    // schedule (with backoff) instead of reconnecting synchronously so a
    // crash-loop cannot spin without delay
    const schedule = this.deps.scheduleReconnect ?? defaultScheduleReconnect
    const chatId = this.chatId
    schedule(() => {
      if (this.closing) return
      // reconnect via launch() so the attempt budget keeps counting up
      this.launch(chatId)
    })
  }
}
