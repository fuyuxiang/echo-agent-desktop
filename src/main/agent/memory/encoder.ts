// src/main/agent/memory/encoder.ts
import type { MemoryLLM } from './llm'
import { parseJsonLoose } from './llm'

export interface SalienceInput {
  userText: string
  assistantText: string
}

const CUES = ['我', '喜欢', '叫', '是', '讨厌', '偏好', '记住', '名字', '住在', '生日']

export class Encoder {
  constructor(private llm: MemoryLLM) {}

  async salience(input: SalienceInput): Promise<number> {
    const prompt =
      `判断下面这轮对话是否包含值得长期记住的用户事实或偏好,给 0 到 1 的显著性分数。\n` +
      `只输出 JSON: {"salience": 数字}\n\n用户: ${input.userText}\n助手: ${input.assistantText}`
    const raw = await this.llm.complete(prompt)
    const parsed = parseJsonLoose<{ salience: number }>(raw)
    if (parsed && typeof parsed.salience === 'number') {
      return Math.max(0, Math.min(1, parsed.salience))
    }
    // 启发式兜底
    const text = input.userText
    const hasCue = CUES.some((c) => text.includes(c))
    return hasCue && text.length >= 4 ? 0.5 : 0.2
  }
}