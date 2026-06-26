// src/main/agent/tools/memory-facade.ts
import type { ChatMessage } from '../providers'

/** 记忆召回命中 */
export interface MemoryHit {
  id: string
  text: string
  score: number
}

/** 记忆门面(P2 冻结接口,P3 实现真实逻辑) */
export interface MemoryGateway {
  /** 按 query 召回相关记忆,供 context-builder 注入 */
  recall(query: string, chatId: string): Promise<MemoryHit[]>
  /** 一轮对话结束后抽取记忆候选 */
  capture(chatId: string, turn: ChatMessage[]): Promise<void>
}

/** P2 占位实现: 不召回不抽取 */
export class NoopMemoryGateway implements MemoryGateway {
  async recall(_query: string, _chatId: string): Promise<MemoryHit[]> {
    return []
  }
  async capture(_chatId: string, _turn: ChatMessage[]): Promise<void> {
    // P3 落地
  }
}
