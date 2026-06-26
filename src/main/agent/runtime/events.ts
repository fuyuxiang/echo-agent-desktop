/** runtime 向外吐的事件,与渲染层现有 WS 帧语义 1:1(Phase 5 接 IPC) */
export type RuntimeEvent =
  | { type: 'streaming'; chatId: string; delta: string; phase: 'text' | 'reasoning' }
  | { type: 'final'; chatId: string; text: string; reasoning?: string }
  | {
      type: 'progress'
      chatId: string
      progressType: 'tool_call' | 'tool_result'
      toolCallId: string
      name: string
      argsText?: string
      resultText?: string
      ok?: boolean
    }
  | { type: 'error'; chatId: string; message: string }
  | { type: 'done'; chatId: string }

export type RuntimeEventHandler = (e: RuntimeEvent) => void