// @vitest-environment node
// ASR 默认配置契约(2026-08 v2:硬编码 baseUrl/model/apiKey)
//
// 契约:
// 1. resolveASRConfig() 同步返回硬编码默认(baseUrl/model/apiKey)
// 2. 返回值包含硅基流动 TeleSpeechASR 默认值,无失败路径
// 3. 类型导出 ASRConfigResolved 字段齐全
import { describe, expect, it } from 'vitest'

describe('ASR 默认配置契约', () => {
  it('resolveASRConfig 同步返回硬编码默认 baseUrl', async () => {
    const { resolveASRConfig } = await import('../config-store')
    const cfg = resolveASRConfig()
    expect(cfg.baseUrl).toBe('https://api.siliconflow.cn/v1/audio/transcriptions')
  })

  it('resolveASRConfig 返回硬编码默认 model', async () => {
    const { resolveASRConfig } = await import('../config-store')
    expect(resolveASRConfig().model).toBe('TeleAI/TeleSpeechASR')
  })

  it('resolveASRConfig 返回非空 apiKey', async () => {
    const { resolveASRConfig } = await import('../config-store')
    const apiKey = resolveASRConfig().apiKey
    expect(apiKey).toBeTruthy()
    expect(apiKey.length).toBeGreaterThan(20)
  })

  it('resolveASRConfig 返回完整 ASRConfigResolved 字段', async () => {
    const { resolveASRConfig } = await import('../config-store')
    const cfg = resolveASRConfig()
    expect(cfg).toEqual({
      baseUrl: expect.any(String),
      model: expect.any(String),
      apiKey: expect.any(String)
    })
  })

  it('多次调用返回稳定的硬编码值(无副作用)', async () => {
    const { resolveASRConfig } = await import('../config-store')
    const a = resolveASRConfig()
    const b = resolveASRConfig()
    expect(a).toEqual(b)
  })
})