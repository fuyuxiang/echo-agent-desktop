// src/main/agent/providers/think-normalizer.ts
import type { ChatProvider, ChatRequest, ChatDelta } from './types'
import { ThinkTagSplitter } from './think-stream'

/**
 * provider 装饰器:把内层 provider 吐出的 text delta 过一遍 think 标签状态机,
 * 将 <think>…</think> 文本切成 reasoning,标签字面量不外泄;其余 delta 原样透传。
 *
 * 这样三种思考来源(reasoning_content / thinking_delta / <think> 文本)在 provider 层
 * 统一归一为 {type:'reasoning'} | {type:'text'},前端只消费结构化 phase,无需懂标签语法。
 */
export class ThinkNormalizingProvider implements ChatProvider {
  // 只读暴露被装饰的底层 provider,便于上层检视协议路由(测试/调试用),不改变装饰行为
  constructor(readonly inner: ChatProvider) {}

  get name(): string {
    return this.inner.name
  }

  async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatDelta> {
    const splitter = new ThinkTagSplitter()
    for await (const delta of this.inner.chat(req, signal)) {
      if (delta.type === 'text') {
        for (const piece of splitter.push(delta.text)) {
          yield piece.kind === 'reasoning'
            ? { type: 'reasoning', text: piece.text }
            : { type: 'text', text: piece.text }
        }
        continue
      }
      // 文本流被 reasoning/tool_call/done 等打断前,先把暂存的尾巴吐净,保持顺序正确
      if (delta.type === 'reasoning' || delta.type === 'tool_call' || delta.type === 'done') {
        for (const piece of splitter.flush()) {
          yield piece.kind === 'reasoning'
            ? { type: 'reasoning', text: piece.text }
            : { type: 'text', text: piece.text }
        }
      }
      yield delta
    }
    // 流自然结束:吐出残留(含未闭合标签内的内容)
    for (const piece of splitter.flush()) {
      yield piece.kind === 'reasoning'
        ? { type: 'reasoning', text: piece.text }
        : { type: 'text', text: piece.text }
    }
  }
}
