import type { ModelConfigDTO } from './server'

/**
 * 模型配置生效策略
 *
 * - A 服务端下发(ModelConfigDTO):由管理员在服务端配置 baseUrl/modelName/凭证
 * - B 本地覆盖(LocalModelConfig):仅当服务端 allowLocalOverride 为真时,用户可在设置页填写并覆盖
 * - resolveEffectiveModelConfig 决定最终生效配置及其来源(server/local)
 */

/** 本地覆盖配置(用户在设置页填写,经 storage 持久化) */
export interface LocalModelConfig {
  baseUrl: string
  modelName: string
}

/** 生效配置:source 标识配置来源 */
export interface EffectiveModelConfig {
  baseUrl: string | null
  modelName: string | null
  source: 'server' | 'local'
}

/**
 * 计算生效的模型配置:
 * - 当服务端允许本地覆盖(allowLocalOverride)且存在本地配置时,使用本地配置(source='local')
 * - 否则一律使用服务端下发配置(source='server')
 */
export function resolveEffectiveModelConfig(
  server: ModelConfigDTO,
  local: LocalModelConfig | null
): EffectiveModelConfig {
  if (server.allowLocalOverride && local) {
    return { baseUrl: local.baseUrl, modelName: local.modelName, source: 'local' }
  }
  return { baseUrl: server.baseUrl, modelName: server.modelName, source: 'server' }
}
