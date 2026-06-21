import type { ModelConfigDTO } from './server'

/** 本地模型(Ollama)配置持久化 key */
export const LOCAL_OLLAMA_CONFIG_KEY = 'modelConfig.localModel'

/** Ollama 写入 yaml 的占位 apiKey(本地端点不校验,但 provider 需要非空值) */
export const OLLAMA_PLACEHOLDER_API_KEY = 'ollama'

/**
 * 模型配置生效策略
 *
 * - A 服务端下发(ModelConfigDTO):由管理员在服务端配置 baseUrl/modelName/凭证
 * - B 本地覆盖(LocalModelConfig):仅当服务端 allowLocalOverride 为真时,用户可在设置页填写并覆盖
 * - C 本地模型(LocalOllamaConfig):用户启用本机 Ollama 时优先级最高,直连本地 OpenAI 兼容端点
 * - resolveEffectiveModelConfig 决定最终生效配置及其来源(server/local/local-model)
 */

/** 本地覆盖配置(用户在设置页填写,经 storage 持久化) */
export interface LocalModelConfig {
  baseUrl: string
  modelName: string
}

/** 本地模型配置(连接本机 Ollama,经 storage 持久化, key=modelConfig.localModel) */
export interface LocalOllamaConfig {
  enabled: boolean
  /** Ollama 服务地址, 如 http://127.0.0.1:11434 (不含 /v1) */
  baseUrl: string
  /** 选中的本地模型名, 如 qwen2.5:7b */
  modelName: string
}

/** 生效配置:source 标识配置来源 */
export interface EffectiveModelConfig {
  baseUrl: string | null
  modelName: string | null
  source: 'server' | 'local' | 'local-model'
}

/**
 * 计算生效的模型配置:
 * - 启用本地模型(Ollama)时优先级最高,直连本机 OpenAI 兼容端点(source='local-model')
 * - 否则当服务端允许本地覆盖(allowLocalOverride)且存在本地配置时,使用本地配置(source='local')
 * - 否则一律使用服务端下发配置(source='server')
 */
export function resolveEffectiveModelConfig(
  server: ModelConfigDTO,
  local: LocalModelConfig | null,
  localModel?: LocalOllamaConfig | null
): EffectiveModelConfig {
  if (localModel?.enabled && localModel.baseUrl && localModel.modelName) {
    return {
      baseUrl: toOllamaOpenAIBase(localModel.baseUrl),
      modelName: localModel.modelName,
      source: 'local-model'
    }
  }
  if (server.allowLocalOverride && local) {
    return { baseUrl: local.baseUrl, modelName: local.modelName, source: 'local' }
  }
  return { baseUrl: server.baseUrl, modelName: server.modelName, source: 'server' }
}

/** 把 Ollama 根地址规整为 OpenAI 兼容端点(确保以 /v1 结尾) */
export function toOllamaOpenAIBase(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`
}
