// src/main/agent/title.ts
/**
 * 会话标题清洗(纯函数,无 Electron 依赖,便于单测)。
 * 用于把 LLM 生成的原始输出整理成简短标题:剥离 think 标签、引号、首尾标点,限制长度。
 */
export function sanitizeTitle(raw: string): string {
  let title = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim()
  // 取第一行,去掉包裹引号与首尾标点
  title = (title.split('\n').find((l) => l.trim()) ?? '').trim()
  title = title.replace(/^["'「『《]+|["'」』》。.\s]+$/g, '').trim()
  if (title.length > 15) title = title.slice(0, 15)
  return title
}
