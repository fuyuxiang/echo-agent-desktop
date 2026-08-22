/**
 * ASR 配置服务门面(2026-08 ASR 云端化重构)
 *
 * 渲染层唯一入口,封装 IPC 调用细节;严禁直接读 store / safeStorage。
 * apiKeyRef 是引用指针,绝不暴露真实 key 给渲染层。
 */

/** 已持久化的 ASR 配置形态(仅 ref 指针,无真实 key) */
export interface ASRConfigDTO {
  baseUrl: string
  model: string
  /** 形如 "ref:asr-api-key",渲染层不能解引用 */
  apiKeyRef?: string
}

export interface ASRConfigInput {
  baseUrl: string
  model: string
  /** 明文 apiKey,主进程负责落 safeStorage;不传 = 仅更新 baseUrl/model */
  apiKey?: string
}

/**
 * 保存 ASR 配置:apiKey 落 safeStorage(系统级加密),baseUrl/model/ref 落普通 store。
 * apiKey 为 undefined 时不清空已有(用于只更新 baseUrl/model),传空串才显式清空。
 */
export async function saveASRConfig(cfg: ASRConfigInput): Promise<void> {
  await window.api.asrConfig.save(cfg)
}

/**
 * 读取已持久化的 ASR 配置。返回 { baseUrl, model, apiKeyRef },无真实 key。
 * 返回 undefined = 未配置。
 */
export async function getASRConfig(): Promise<ASRConfigDTO | undefined> {
  return window.api.asrConfig.get()
}

/** 清空 ASR 配置(普通 store + safeStorage 同步清) */
export async function clearASRConfig(): Promise<void> {
  await window.api.asrConfig.clear()
}

/** 是否已配置(apiKeyRef 非空) */
export function isASRConfigured(cfg: ASRConfigDTO | undefined): boolean {
  return !!cfg?.baseUrl && !!cfg.model && !!cfg.apiKeyRef
}