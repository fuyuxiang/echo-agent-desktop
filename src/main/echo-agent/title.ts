// src/main/echo-agent/title.ts
import type { ChatProvider } from '../agent/providers/types'
import { sanitizeTitle } from '../agent/title'
import { setLLMConfig, getLLMProvider, type LLMConfig } from './llm'

/** 兼容旧调用方:标题配置即共享 LLM 配置 */
export function setTitleModelConfig(cfg: LLMConfig | null): void {
  setLLMConfig(cfg)
}

export function buildTitlePrompt(firstUserMessage: string): string {
  return [
    '你是会话标题生成器。根据用户的第一条消息,生成一个简短的中文标题概括对话主题。',
    '要求:',
    '1. 4 到 12 个汉字,不要超过 15 字。',
    '2. 只输出标题本身,不要引号、标点、解释或前后缀。',
    '3. 概括主题,而非复述原文。',
    '',
    `用户消息:${firstUserMessage.slice(0, 500)}`
  ].join('\n')
}

export async function generateTitle(
  firstUserMessage: string,
  deps?: { provider?: ChatProvider }
): Promise<string> {
  if (!firstUserMessage.trim()) return ''
  const provider = deps?.provider ?? getLLMProvider()
  if (!provider) return ''

  const signal = AbortSignal.timeout(8000)
  try {
    let out = ''
    for await (const delta of provider.chat(
      {
        model: '',
        messages: [{ role: 'user', content: buildTitlePrompt(firstUserMessage) }],
        temperature: 0.3,
        maxTokens: 40
      },
      signal
    )) {
      if (delta.type === 'text') out += delta.text
      else if (delta.type === 'error') return ''
    }
    return sanitizeTitle(out)
  } catch {
    return ''
  }
}
