// src/shared/provider-presets.ts

export type ProviderProtocol = 'openai' | 'anthropic'

/** 厂商预设(不含 key);baseUrl 为各家 OpenAI 兼容/原生端点根 */
export interface ProviderPreset {
  id: string
  label: string
  protocol: ProviderProtocol
  baseUrl: string
  models: string[]
}

/** 全覆盖国内外主流厂商。baseUrl 以实现时官方文档为准,此处为已知默认值。 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'deepseek', label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'] },
  { id: 'qwen', label: '通义千问', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-long', 'qwq-32b'] },
  { id: 'moonshot', label: 'Kimi / Moonshot', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', models: ['kimi-latest', 'moonshot-v1-128k', 'moonshot-v1-32k', 'moonshot-v1-8k'] },
  { id: 'zhipu', label: '智谱 GLM', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-plus', 'glm-4-long', 'glm-4-flash', 'glm-4'] },
  { id: 'doubao', label: '豆包', protocol: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-seed-2-1-pro', 'doubao-1.5-pro-256k', 'doubao-1.5-pro-32k', 'doubao-1.5-lite-32k'] },
  { id: 'siliconflow', label: '硅基流动', protocol: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', models: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen3-235B-A22B', 'Qwen/Qwen2.5-72B-Instruct'] },
  { id: 'minimax', label: 'MiniMax', protocol: 'openai', baseUrl: 'https://api.minimax.chat/v1', models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-Text-01'] },
  { id: 'stepfun', label: '阶跃星辰', protocol: 'openai', baseUrl: 'https://api.stepfun.com/v1', models: ['step-3.7-flash', 'step-3.5-flash', 'step-2-16k'] },
  { id: 'baichuan', label: '百川', protocol: 'openai', baseUrl: 'https://api.baichuan-ai.com/v1', models: ['Baichuan-Omni-1.5', 'Baichuan4-Turbo', 'Baichuan4-Air'] },
  { id: 'ernie', label: '文心一言 ERNIE', protocol: 'openai', baseUrl: 'https://qianfan.baidubce.com/v2', models: ['ernie-5.1-8k', 'ernie-4.5-turbo-latest', 'ernie-4.5-8k', 'ernie-4.0-8k'] },
  { id: 'openai', label: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'o3', 'o4-mini', 'gpt-4o'] },
  { id: 'anthropic', label: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', models: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5'] },
  { id: 'gemini', label: 'Google Gemini', protocol: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'] },
  { id: 'openrouter', label: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', models: ['anthropic/claude-sonnet-4-6', 'openai/gpt-4.1', 'google/gemini-2.5-flash', 'deepseek/deepseek-v4-flash'] }
]

export function getPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id)
}
