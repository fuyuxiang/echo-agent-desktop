// src/main/agent/providers/presets.ts

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
  { id: 'deepseek', label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'qwen', label: '通义千问', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-max', 'qwen-plus', 'qwen-turbo'] },
  { id: 'moonshot', label: 'Kimi / Moonshot', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'] },
  { id: 'zhipu', label: '智谱 GLM', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-plus', 'glm-4', 'glm-4-flash'] },
  { id: 'baichuan', label: '百川', protocol: 'openai', baseUrl: 'https://api.baichuan-ai.com/v1', models: ['Baichuan4', 'Baichuan3-Turbo'] },
  { id: 'minimax', label: 'MiniMax', protocol: 'openai', baseUrl: 'https://api.minimax.chat/v1', models: ['abab6.5s-chat'] },
  { id: 'stepfun', label: '阶跃星辰', protocol: 'openai', baseUrl: 'https://api.stepfun.com/v1', models: ['step-1-8k', 'step-2-16k'] },
  { id: 'yi', label: '零一万物 Yi', protocol: 'openai', baseUrl: 'https://api.lingyiwanwu.com/v1', models: ['yi-large', 'yi-medium'] },
  { id: 'siliconflow', label: '硅基流动', protocol: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'] },
  { id: 'doubao', label: '火山豆包', protocol: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-pro-32k', 'doubao-pro-128k'] },
  { id: 'ernie', label: '文心一言 ERNIE', protocol: 'openai', baseUrl: 'https://qianfan.baidubce.com/v2', models: ['ernie-4.0-8k', 'ernie-3.5-8k'] },
  { id: 'openai', label: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini', 'o1'] },
  { id: 'gemini', label: 'Google Gemini', protocol: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', models: ['gemini-2.0-flash', 'gemini-1.5-pro'] },
  { id: 'openrouter', label: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', models: ['anthropic/claude-3.5-sonnet'] },
  { id: 'anthropic', label: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', models: ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'] }
]

export function getPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id)
}
