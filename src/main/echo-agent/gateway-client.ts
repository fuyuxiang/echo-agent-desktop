import WebSocket from 'ws'

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
  readonly readyState: number
}

export interface GatewayClientDeps {
  wsUrl: string
  // loopback + auth.mode=open 下 echo-agent 放行,无需 token;仅当将来启用 api_tokens 时传入
  token?: string
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
  private pendingSends: string[] = []
  private closing = false
  private reconnectAttempts = 0
  /**
   * 活跃请求表:key=requestId,value=AbortController。
   * 旧实现按 chatId 索引,会导致多个并发请求互相覆盖 AbortController;
   * 改为 requestId 索引后,Stop 只中止当前请求,不影响后续。
   */
  private activeRequests = new Map<string, AbortController>()
  // echo-agent 的正式关联键是 accepted.event_id / metadata._inbound_event_id。
  // Desktop 自己的 requestId 只存在于 UI,这里维护双向映射把两套协议接起来。
  private awaitingAccepted: string[] = []
  private requestToEventId = new Map<string, string>()
  private eventToRequestId = new Map<string, string>()

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

  /**
   * 发送文本到 gateway。
   * @param requestId 唯一请求 ID(由调用方生成)。流式响应按 requestId 路由,
   *                  Stop 也按 requestId 精准中止。
   * @param text 非空(由 IPC 层守门,这里再次 assert 兜底)
   */
  send(
    text: string,
    attachments?: Array<{ id: string; name: string }>,
    requestId?: string
  ): void {
    if (!text || !text.trim()) {
      // 兜底:IPC 层已拒绝空文本,这里防止直接调用绕过守门
      throw new Error('GatewayClient.send: empty text not allowed')
    }
    const rid = requestId ?? this.generateRequestId()
    const controller = new AbortController()
    this.activeRequests.set(rid, controller)
    this.awaitingAccepted.push(rid)

    const frame = JSON.stringify({ type: 'message', text, attachments, request_id: rid })
    if (this.ws && this.authed) {
      this.ws.send(frame)
      return
    }
    this.pendingSends.push(frame)
    // self-heal: if the reconnect budget was exhausted (ws was dropped), a new
    // send re-establishes the connection so the buffered frame can flush after
    // auth_ok. connect() resets the reconnect budget.
    if (!this.ws && !this.closing && this.chatId) {
      this.connect(this.chatId)
    }
  }

  private generateRequestId(): string {
    // 简单 fallback:时间戳 + 随机。优先由 IPC 调用方传 requestId。
    return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }

  disconnect(): void {
    this.closing = true
    this.ws?.close()
    this.ws = null
    this.authed = false
    this.pendingSends = []
    // 清理所有活跃请求
    for (const controller of this.activeRequests.values()) {
      controller.abort()
    }
    this.activeRequests.clear()
    this.awaitingAccepted = []
    this.requestToEventId.clear()
    this.eventToRequestId.clear()
  }

  /**
   * 中止请求。
   * @param _chatId 会话 ID(保留 IPC 兼容;Gateway 已由当前 WS 会话确定)
   * @param requestId 请求 ID(优先匹配);若省略,中止该会话当前活跃请求
   */
  abort(_chatId: string, requestId?: string): void {
    let controller: AbortController | undefined
    if (requestId) {
      controller = this.activeRequests.get(requestId)
    } else {
      // 兜底:按 chatId 找最近的一个活跃请求
      for (const [rid, c] of this.activeRequests) {
        if (rid.startsWith(`req-`)) {
          controller = c
          if (requestId === undefined) break
        }
      }
    }
    if (controller) {
      controller.abort()
      // Don't delete from activeRequests here — onFrame() checks
      // signal.aborted to suppress further events. The entry will be
      // cleaned up by done/error events or by disconnect().
    }

    // echo-agent 使用 interrupt + accepted.event_id。尚未收到 accepted 时发送
    // 无 target 的兼容帧;accepted 到达后会再补一条精确 target。
    if (controller && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'interrupt',
        event_id: requestId ? this.requestToEventId.get(requestId) : undefined
      }))
    }
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
      for (const pending of this.pendingSends) {
        this.ws?.send(pending)
      }
      this.pendingSends = []
      return
    }
    if (frame.type === 'accepted') {
      const eventId = typeof frame.event_id === 'string' ? frame.event_id : ''
      if (eventId) {
        const requestId = this.awaitingAccepted.shift()
        if (requestId) {
          this.requestToEventId.set(requestId, eventId)
          this.eventToRequestId.set(eventId, requestId)
          if (this.activeRequests.get(requestId)?.signal.aborted &&
              this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'interrupt', event_id: eventId }))
          }
        }
      }
      return
    }
    // If the request was aborted, don't emit further events and clean up.
    const meta = frame.metadata as Record<string, unknown> | undefined
    const inboundEventId = String(meta?._inbound_event_id ?? frame.reply_to_id ?? '')
    const reqId = (frame.request_id as string | undefined) ||
      this.eventToRequestId.get(inboundEventId) ||
      (this.activeRequests.size === 1 ? this.activeRequests.keys().next().value : undefined)
    const active = reqId ? this.activeRequests.get(reqId) : undefined
    if (active?.signal.aborted) {
      if (frame.type === 'error' || frame.is_final === true || frame.message_kind === 'final') {
        if (reqId) this.cleanupRequest(reqId)
      }
      return
    }
    const events = translateFrame(frame, this.chatId)
    // 把 frame.request_id 透传出去,渲染端按 requestId 路由 chunk
    for (const ev of events) {
      if (reqId && ev.request_id == null) {
        ev.request_id = reqId
      }
      this.deps.emit(ev)
      // 流完成或出错时清理活跃请求
      if (ev.type === 'done' || ev.type === 'error') {
        if (reqId) this.cleanupRequest(reqId)
      }
    }
  }

  private cleanupRequest(requestId: string): void {
    this.activeRequests.delete(requestId)
    this.awaitingAccepted = this.awaitingAccepted.filter((id) => id !== requestId)
    const eventId = this.requestToEventId.get(requestId)
    this.requestToEventId.delete(requestId)
    if (eventId) this.eventToRequestId.delete(eventId)
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
