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
}

export class GatewayClient {
  private ws: WsLike | null = null
  private chatId = ''
  private authed = false
  private pendingSend: string | null = null
  private closing = false

  constructor(private deps: GatewayClientDeps) {}

  connect(chatId: string): void {
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
    } else {
      this.pendingSend = frame
    }
  }

  disconnect(): void {
    this.closing = true
    this.ws?.close()
    this.ws = null
    this.authed = false
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
    // unexpected close → reconnect once to the same chat
    this.connect(this.chatId)
  }
}
