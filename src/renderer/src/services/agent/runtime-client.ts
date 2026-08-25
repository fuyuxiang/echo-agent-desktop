// src/renderer/src/services/agent/runtime-client.ts
export type WsEventHandler = (payload: Record<string, unknown>) => void

/**
 * 生成 requestId:用于把一次"发送文本"的整个流式响应生命周期串起来。
 * 切换会话后旧 requestId 的 chunk 会被静默丢弃,不会落入新会话。
 */
function generateRequestId(): string {
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 生成 skill request_id:与 message requestId 区分前缀(skill-*),便于路由识别。
 * skill 请求独立于 activeRequestId,不参与 message 流式响应的 requestId 配对。
 */
function generateSkillRequestId(): string {
  return `skill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
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
   * 拉取已安装 skills 列表。
   * 内部:生成 request_id,通过 IPC 发 skill.list 帧;在 'skill.list' 通道里按 request_id
   * 匹配到 skill.list_result(成功)/error(失败)后 resolve/reject,自带 10s 超时。
   */
  sendSkillList(): Promise<Array<Record<string, unknown>>> {
    const rid = generateSkillRequestId()
    return new Promise((resolve, reject) => {
      let settled = false
      const handler = (ev: Record<string, unknown>): void => {
        if (settled) return
        if (ev.request_id !== rid) return
        if (ev.type === 'skill.list_result') {
          settled = true
          agentWs.off('skill.list', handler)
          resolve((ev.skills as Array<Record<string, unknown>>) ?? [])
        } else if (ev.type === 'error') {
          settled = true
          agentWs.off('skill.list', handler)
          reject(new Error(String(ev.message ?? 'unknown error')))
        }
      }
      agentWs.on('skill.list', handler)
      void window.api.agentChat.sendSkillList(rid)
      setTimeout(() => {
        if (!settled) {
          settled = true
          agentWs.off('skill.list', handler)
          reject(new Error('sendSkillList timeout'))
        }
      }, 10_000)
    })
  }

  /** 启用指定 skill(IPC 触发 echo-agent 在网关侧开启),等 accepted/ack 后 resolve。 */
  sendSkillEnable(name: string): Promise<void> {
    return this.sendSkillVoidFrame('skill.enable', name)
  }

  /** 关闭指定 skill,等 accepted/ack 后 resolve。 */
  sendSkillDisable(name: string): Promise<void> {
    return this.sendSkillVoidFrame('skill.disable', name)
  }

  private sendSkillVoidFrame(
    type: 'skill.enable' | 'skill.disable',
    name: string
  ): Promise<void> {
    const rid = generateSkillRequestId()
    return new Promise((resolve, reject) => {
      let settled = false
      const handler = (ev: Record<string, unknown>): void => {
        if (settled) return
        if (ev.request_id !== rid) return
        if (ev.type === 'accepted') {
          settled = true
          agentWs.off('skill.list', handler)
          resolve()
        } else if (ev.type === 'error') {
          settled = true
          agentWs.off('skill.list', handler)
          reject(new Error(String(ev.message ?? 'unknown error')))
        }
      }
      agentWs.on('skill.list', handler)
      void (type === 'skill.enable'
        ? window.api.agentChat.sendSkillEnable(name, rid)
        : window.api.agentChat.sendSkillDisable(name, rid))
      setTimeout(() => {
        if (!settled) {
          settled = true
          agentWs.off('skill.list', handler)
          reject(new Error(`${type} timeout`))
        }
      }, 10_000)
    })
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
   * - skill.* 帧不走 message requestId 路由,直接转发到 'skill.list' 通道
   *   (handler 内部按 request_id 自行配对,因为 skill 请求是独立的 fire-and-await-ack)
   */
  private route(ev: Record<string, unknown>): void {
    const type = ev.type as string

    // skill.* 帧必须在 activeRequestId 过滤前转发——skill 帧的 request_id
    // 是 'skill-...' 前缀,跟 message 的 'req-...' 完全不同,会直接被过滤掉。
    // 全部走单一 'skill.list' 通道,handler 内部按 ev.type/request_id 区分。
    if (typeof type === 'string' && type.startsWith('skill.')) {
      this.emit('skill.list', ev)
      return
    }

    const evReqId = ev.request_id as string | undefined
    const evChatId = ev.chatId as string | undefined

    // requestId 路由优先
    if (evReqId) {
      if (evReqId !== this.activeRequestId) return
    } else {
      // 兜底:按 chatId 过滤(防串会话)
      if (evChatId && evChatId !== this.chatId) return
    }

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
