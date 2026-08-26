/** 本地手动配置(用户在设置页填写)持久化 key */
export const LOCAL_CONFIG_KEY = 'modelConfig.local'

/** 本地模型(Ollama)配置持久化 key */
export const LOCAL_OLLAMA_CONFIG_KEY = 'modelConfig.localModel'

/** Ollama 写入 yaml 的占位 apiKey(本地端点不校验,但 provider 需要非空值) */
export const OLLAMA_PLACEHOLDER_API_KEY = 'ollama'

/** 本地模型配置(连接本机 Ollama,经 storage 持久化, key=modelConfig.localModel) */
export interface LocalOllamaConfig {
  enabled: boolean
  /** Ollama 服务地址, 如 http://127.0.0.1:11434 (不含 /v1) */
  baseUrl: string
  /** 选中的本地模型名, 如 qwen2.5:7b */
  modelName: string
}

/** 把 Ollama 根地址规整为 OpenAI 兼容端点(确保以 /v1 结尾) */
export function toOllamaOpenAIBase(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`
}
