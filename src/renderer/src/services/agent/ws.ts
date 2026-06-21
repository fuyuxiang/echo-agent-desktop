import { logger } from '@/utils/logger'

export type WsEventHandler = (payload: Record<string, unknown>) => void

interface WsFrame {
  type: string
  [key: string]: unknown
}

/**
 * echo-agent WebSocket 连接管理器
 * 负责连接/认证/重连/事件分发
 */
export class AgentWebSocket {
  private ws: WebSocket | null = null
  private listeners = new Map<string, Set<WsEventHandler>>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private maxReconnectDelay = 30_000
  private pingInterval: ReturnType<typeof setInterval> | null = null
  private url = ''
  private token = ''
  private platform = 'desktop'
  private userId = 'local-user'
  private chatId = ''
  private intentionalClose = false

  connect(url: string, chatId: string, token = ''): void {
    this.url = url
    this.chatId = chatId
    this.token = token
    this.intentionalClose = false
    this.closeCurrentSocket()
    this.doConnect()
  }

  disconnect(): void {
    this.intentionalClose = true
    this.stopPing()
    this.clearReconnect()
    if (this.ws) {
      this.ws.close(1000, 'client disconnect')
      this.ws = null
    }
  }

  /** 切换会话（断开重连，新 chatId） */
  switchSession(chatId: string): void {
    this.chatId = chatId
    this.closeCurrentSocket()
    this.intentionalClose = false
    this.doConnect()
  }

  /** 发送消息 */
  sendMessage(text: string): void {
    this.send({ type: 'message', text })
  }

  on(event: string, handler: WsEventHandler): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(handler)
  }

  off(event: string, handler: WsEventHandler): void {
    this.listeners.get(event)?.delete(handler)
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  private doConnect(): void {
    try {
      logger.info(`[ws] 正在连接: ${this.url}`)
      this.ws = new WebSocket(this.url)

      this.ws.onopen = (): void => {
        logger.info(`[ws] 连接成功: ${this.url}`)
        this.reconnectAttempts = 0
        this.sendAuth()
        this.startPing()
      }

      this.ws.onmessage = (event: MessageEvent): void => {
        try {
          const frame: WsFrame = JSON.parse(event.data as string)
          this.dispatch(frame)
        } catch (e) {
          logger.warn('[ws] 解析帧失败:', e)
        }
      }

      this.ws.onclose = (event: CloseEvent): void => {
        logger.info(`[ws] 断开 code=${event.code}`)
        this.stopPing()
        this.emit('_disconnected', {})
        if (!this.intentionalClose) {
          this.scheduleReconnect()
        }
      }

      this.ws.onerror = (error: Event): void => {
        logger.error('[ws] 错误:', error)
      }
    } catch (e) {
      logger.error('[ws] 连接失败:', e)
      this.scheduleReconnect()
    }
  }

  private sendAuth(): void {
    this.send({
      type: 'auth',
      platform: this.platform,
      user_id: this.userId,
      chat_id: this.chatId,
      token: this.token
    })
  }

  private send(data: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    }
  }

  private dispatch(frame: WsFrame): void {
    const { type, ...payload } = frame
    const previewLen =
      typeof payload.text === 'string'
        ? payload.text.length
        : typeof payload.delta === 'string'
          ? payload.delta.length
          : 0
    logger.info(
      `[ws:dispatch] type=${type} kind=${payload.message_kind ?? ''} len=${previewLen}`
    )
    this.emit(type, payload)

    // 按 message_kind 细分事件
    if (type === 'message' && payload.message_kind) {
      this.emit(`message.${payload.message_kind}`, payload)
    }
  }

  private emit(event: string, payload: Record<string, unknown>): void {
    this.listeners.get(event)?.forEach((handler) => {
      try {
        handler(payload)
      } catch (e) {
        logger.error(`[ws] handler error for ${event}:`, e)
      }
    })
  }

  private startPing(): void {
    this.pingInterval = setInterval(() => {
      this.send({ type: 'ping' })
    }, 30_000)
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
  }

  private closeCurrentSocket(): void {
    this.stopPing()
    this.clearReconnect()
    if (!this.ws) return

    const current = this.ws
    current.onclose = null
    current.onerror = null
    current.onmessage = null
    current.onopen = null

    if (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING) {
      current.close(1000, 'replace connection')
    }
    this.ws = null
  }

  private scheduleReconnect(): void {
    this.clearReconnect()
    this.reconnectAttempts++
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), this.maxReconnectDelay)
    logger.info(`[ws] 将在 ${delay}ms 后重连 (第 ${this.reconnectAttempts} 次)`)
    this.reconnectTimer = setTimeout(() => this.doConnect(), delay)
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}

/** 全局单例 */
export const agentWs = new AgentWebSocket()
