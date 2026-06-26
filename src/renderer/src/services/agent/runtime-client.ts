// src/renderer/src/services/agent/runtime-client.ts
export type WsEventHandler = (payload: Record<string, unknown>) => void

class RuntimeClient {
  private listeners = new Map<string, Set<WsEventHandler>>()
  private chatId = ''
  private unsubscribe: (() => void) | null = null
  private _connected = false

  connect(_url: string, chatId: string, _token = ''): void {
    this.chatId = chatId
    this.subscribe()
    this._connected = true
  }

  switchSession(chatId: string): void {
    this.chatId = chatId
  }

  disconnect(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this._connected = false
    this.emit('_disconnected', {})
  }

  sendMessage(text: string, attachments?: Array<{ id: string; name: string }>): void {
    void window.api.agentChat.send(this.chatId, text, attachments)
  }

  on(event: string, handler: WsEventHandler): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(handler)
  }

  off(event: string, handler: WsEventHandler): void {
    this.listeners.get(event)?.delete(handler)
  }

  get connected(): boolean {
    return this._connected
  }

  private subscribe(): void {
    if (this.unsubscribe) return
    this.unsubscribe = window.api.agentChat.onEvent((ev) => this.route(ev))
  }

  /** 把 RuntimeEvent 按 type 重 emit 成旧 WS 事件名,保持消费点兼容。 */
  private route(ev: Record<string, unknown>): void {
    const type = ev.type as string
    if (type === 'streaming') this.emit('message.streaming', ev)
    else if (type === 'final') this.emit('message.final', ev)
    else if (type === 'progress') this.emit('message.progress', ev)
    else if (type === 'error') this.emit('message.error', ev)
    else if (type === 'done') this.emit('message.done', ev)
    // 兼容旧 'final' 裸事件名(summarize 同时监听了 'final')
    if (type === 'final') this.emit('final', ev)
  }

  private emit(event: string, payload: Record<string, unknown>): void {
    this.listeners.get(event)?.forEach((h) => {
      try {
        h(payload)
      } catch {
        // 单个 handler 异常不影响其它
      }
    })
  }
}

/** 全局单例(同名替换旧 agentWs)。 */
export const agentWs = new RuntimeClient()
