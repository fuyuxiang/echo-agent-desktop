/**
 * 解析并提取内容中的思考过程标记
 *
 * 支持多种模型的思考过程标记格式：
 * - `<think>...</think>` (MiniMax, DeepSeek-R1 某些版本)
 * - `<thinking>...</thinking>` (某些模型变体)
 * - 其他模型的原生 reasoning 字段由后端 Provider 直接处理
 *
 * 这个函数将：
 * 1. 提取标签中的内容作为 reasoning
 * 2. 从原文中移除标签，只保留实际回复内容
 *
 * @example
 * ```ts
 * const text = "<think>让我想想...</think>\n\n你好！"
 * const result = parseThinkingTags(text)
 * // result.reasoning = "让我想想..."
 * // result.content = "你好！"
 * ```
 */
export function parseThinkingTags(text: string): { reasoning: string; content: string } {
  // 支持多种思考标记格式（按优先级）
  const patterns = [
    /<think>([\s\S]*?)<\/think>/gi,       // <think> 标签（MiniMax 等）
    /<thinking>([\s\S]*?)<\/thinking>/gi   // <thinking> 标签（某些模型变体）
  ]

  const matches: string[] = []
  let cleanedText = text

  // 按顺序尝试每种模式
  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      matches.push(match[1].trim())
    }
    // 移除匹配到的标签
    cleanedText = cleanedText.replace(pattern, '')
  }

  // 清理移除标签后的多余空行
  const content = cleanedText
    .replace(/\n{3,}/g, '\n\n') // 将3个或以上连续换行替换为2个
    .trim()

  // 合并所有提取的思考内容
  const reasoning = matches.filter(Boolean).join('\n\n')

  return { reasoning, content }
}
