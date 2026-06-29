import { createProvider } from '../agent/providers/factory'
import type { ChatProvider } from '../agent/providers/types'

export interface LLMConfig {
  baseUrl: string
  apiKey: string
  model: string
}

let llmConfig: LLMConfig | null = null

export function setLLMConfig(cfg: LLMConfig | null): void {
  llmConfig = cfg
}

export function getLLMConfig(): LLMConfig | null {
  return llmConfig
}

export function getLLMProvider(): ChatProvider | null {
  if (!llmConfig) return null
  return createProvider({
    providerId: 'openai',
    model: llmConfig.model,
    baseUrl: llmConfig.baseUrl,
    apiKey: llmConfig.apiKey
  })
}
