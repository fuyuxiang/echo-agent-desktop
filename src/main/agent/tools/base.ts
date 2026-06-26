// src/main/agent/tools/base.ts

/** 工具执行进度(供 runtime 转 progress 事件) */
export interface ToolProgress {
  kind: 'tool_call' | 'tool_result'
  toolCallId: string
  name: string
  /** kind=tool_call: 入参 JSON 文本 */
  argsText?: string
  /** kind=tool_result: 结果文本 */
  resultText?: string
  /** kind=tool_result: 是否成功 */
  ok?: boolean
}

/** 工具执行上下文 */
export interface ToolContext {
  chatId: string
  /** 当前生效工作目录 */
  workspace: string
  signal: AbortSignal
  onProgress: (p: ToolProgress) => void
}

/** 工具执行结果 */
export interface ToolResult {
  ok: boolean
  content: string
  /** 内容被截断时为 true */
  truncated?: boolean
}

/** 统一工具接口 */
export interface Tool {
  name: string
  description: string
  /** JSON Schema 对象,经 registry.toSchemas() 转 ToolSchema 给 provider */
  parameters: Record<string, unknown>
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}