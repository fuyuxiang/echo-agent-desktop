// src/renderer/src/services/agent/runtime-client.ts
export type WsEventHandler = (payload: Record<string, unknown>) => void

/**
 * 生成 requestId:用于把一次"发送文本"的整个流式响应生命周期串起来。
 * 切换会话后旧 requestId 的 chunk 会被静默丢弃,不会落入新会话。
 */
function generateRequestId(): string {
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

class RuntimeClient {
  private listeners = new Map<string, Set<WsEventHandler>>()
  private chatId = ''
  /** 当前活跃 requestId(最近一次 send 生成);空 = 没有流在跑 */
  private activeRequestId = ''
  private unsubscribe: (() => void) | null = null
  private _connected = false

  connect(_url: string, chatId: string, _token = ''): void {
    this.chatId = chatId
    this.subscribe()
    this._connected = true
  }

  async switchSession(chatId: string): Promise<void> {
    this.chatId = chatId
    // 切换会话:丢弃旧 requestId 的所有未到达 chunk
    this.activeRequestId = ''

    // Notify the main process to switch the gateway session.
    // 注意:只切会话,绝不发送任何文本;发送是用户显式输入触发的动作。
    try {
      await window.api.agentChat.switchSession(chatId)
    } catch (e) {
      console.warn('[runtime-client] switchSession failed:', e)
    }
  }

  disconnect(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this._connected = false
    this.activeRequestId = ''
    this.emit('_disconnected', {})
  }

  /**
   * 发送消息。返回 requestId 以便后续按 requestId 中止/丢弃。
   * 调用方负责保证 text 非空(IPC 守门会抛 EmptyMessageError)。
   */
  sendMessage(text: string, attachments?: Array<{ id: string; name: string }>): string {
    const rid = generateRequestId()
    this.activeRequestId = rid
    void window.api.agentChat.send(this.chatId, text, attachments, rid)
    return rid
  }

  /**
   * 中止当前活跃请求(若有)。
   * UI 的 Stop 按钮调这里;会同时调后端 abort 和本地丢弃后续 chunk。
   */
  abortActive(): void {
    if (!this.activeRequestId) return
    void window.api.agentChat.abort(this.chatId, this.activeRequestId)
    this.activeRequestId = ''
  }

  /** 当前活跃 requestId(给 UI 显示) */
  get currentRequestId(): string {
    return this.activeRequestId
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

  /**
   * 把 RuntimeEvent 按 type 重 emit 成旧 WS 事件名,保持消费点兼容。
   * 过滤策略:
   * - 优先按 requestId 匹配(ev.request_id);命中则放行
   * - 没有 requestId 时按 chatId 兜底(向后兼容旧 frame)
   * - 已切换会话的旧请求,requestId 不再等于 activeRequestId,直接丢弃
   */
  private route(ev: Record<string, unknown>): void {
    const evReqId = ev.request_id as string | undefined
    const evChatId = ev.chatId as string | undefined

    // requestId 路由优先
    if (evReqId) {
      if (evReqId !== this.activeRequestId) return
    } else {
      // 兜底:按 chatId 过滤(防串会话)
      if (evChatId && evChatId !== this.chatId) return
    }

    const type = ev.type as string
    if (type === 'streaming') this.emit('message.streaming', ev)
    else if (type === 'final') this.emit('message.final', ev)
    else if (type === 'progress') this.emit('message.progress', ev)
    else if (type === 'error') this.emit('message.error', ev)
    else if (type === 'done') {
      this.emit('message.done', ev)
      // 流结束后清空 activeRequestId,允许下一次 send 生成新 rid
      if (evReqId === this.activeRequestId) this.activeRequestId = ''
    }
    // 兼容旧 'final' 裸事件名(summarize 同时监听了 'final')
    if (type === 'final') this.emit('final', ev)
    // 项目记忆候选下行:agent 推送 type='memory-candidate' 的事件后,
    // 这里把它转成 'memory-candidate' 通道供 ChatPage 触发 ShareMemoryDialog。
    if (type === 'memory-candidate') this.emit('memory-candidate', ev)
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
