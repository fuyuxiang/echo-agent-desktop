/** 对话角色 */
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

/** 一次工具调用(模型发起) */
export interface ToolCall {
  id: string
  name: string
  /** 入参,JSON 字符串(流式拼接完成后应为合法 JSON) */
  arguments: string
}

/** 对话消息 */
export interface ChatMessage {
  role: ChatRole
  content: string
  /** role=assistant 时模型发起的工具调用 */
  toolCalls?: ToolCall[]
  /** role=tool 时对应的 tool_call id */
  toolCallId?: string
  /** role=tool 时工具名 */
  name?: string
}

/** 暴露给模型的工具描述(parameters 为 JSON Schema 对象) */
export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** 一次对话请求 */
export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  tools?: ToolSchema[]
  temperature?: number
  maxTokens?: number
}

/** 流式增量事件(各 provider 归一化后统一吐出) */
export type ChatDelta =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: 'usage'; promptTokens?: number; completionTokens?: number }
  | { type: 'done'; finishReason?: string }
  | { type: 'error'; message: string }

/** provider 凭据(仅主进程内部使用,不外泄渲染层) */
export interface ProviderCredentials {
  apiKey: string
  baseUrl: string
}

/** 统一 provider 接口 */
export interface ChatProvider {
  readonly name: string
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatDelta>
}
