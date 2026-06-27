/**
 * 解析并提取内容中的 <think> 标签
 *
 * 某些 LLM（如 DeepSeek、部分 OpenAI 兼容模型）会在回复中使用 <think> 标签包裹思考过程。
 * 这个函数将：
 * 1. 提取 <think>...</think> 中的内容作为 reasoning
 * 2. 从原文中移除 <think> 标签，只保留实际回复内容
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
  // 匹配 <think>...</think> 标签（支持多行、嵌套）
  const thinkRegex = /<think>([\s\S]*?)<\/think>/gi
  const matches: string[] = []
  let match: RegExpExecArray | null

  // 提取所有 <think> 标签内容
  while ((match = thinkRegex.exec(text)) !== null) {
    matches.push(match[1].trim())
  }

  // 移除所有 <think> 标签，保留纯内容，并清理多余空行
  const content = text
    .replace(thinkRegex, '')
    .replace(/\n{3,}/g, '\n\n') // 将3个或以上连续换行替换为2个
    .trim()

  // 合并多个 thinking 块
  const reasoning = matches.filter(Boolean).join('\n\n')

  return { reasoning, content }
}
