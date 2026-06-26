// src/main/agent/providers/factory.ts
import { getPreset } from './presets'
import { OpenAICompatProvider } from './openai-compatible'
import { AnthropicProvider } from './anthropic'
import type { ChatProvider, ProviderCredentials } from './types'

/** 上层解析(服务器下发/本地 override/自定义)后的生效模型配置 */
export interface ResolvedModelConfig {
  providerId: string
  model: string
  /** 自定义 baseUrl;为空则用预设 baseUrl */
  baseUrl: string
  apiKey: string
}

/**
 * 按生效配置构造 provider。
 * - 预设存在: 用其 protocol;baseUrl 优先用 cfg.baseUrl,否则预设 baseUrl
 * - 预设缺失(自定义网关): 默认 openai 兼容协议,必须自带 baseUrl
 */
export function createProvider(cfg: ResolvedModelConfig, fetchImpl?: typeof fetch): ChatProvider {
  const preset = getPreset(cfg.providerId)
  const baseUrl = cfg.baseUrl || preset?.baseUrl || ''
  const creds: ProviderCredentials = { apiKey: cfg.apiKey, baseUrl }
  const protocol = preset?.protocol ?? 'openai'
  if (protocol === 'anthropic') return new AnthropicProvider(cfg.providerId, creds, fetchImpl)
  return new OpenAICompatProvider(cfg.providerId, creds, fetchImpl)
}
