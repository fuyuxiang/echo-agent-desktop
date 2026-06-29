// src/main/echo-agent/title.ts
import { createProvider } from '../agent/providers/factory'
import type { ChatProvider } from '../agent/providers/types'
import { sanitizeTitle } from '../agent/title'

export interface TitleModelConfig {
  baseUrl: string
  apiKey: string
  model: string
}

let titleConfig: TitleModelConfig | null = null

export function setTitleModelConfig(cfg: TitleModelConfig | null): void {
  titleConfig = cfg
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
  const provider =
    deps?.provider ??
    (titleConfig
      ? createProvider({
          providerId: 'openai',
          model: titleConfig.model,
          baseUrl: titleConfig.baseUrl,
          apiKey: titleConfig.apiKey
        })
      : null)
  if (!provider) return ''

  const model = titleConfig?.model ?? 'gpt-4o-mini'
  const signal = AbortSignal.timeout(8000)
  try {
    let out = ''
    for await (const delta of provider.chat(
      {
        model,
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
