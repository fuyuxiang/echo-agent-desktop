// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  get: vi.fn<(key: string) => string | undefined>(),
  secureGet: vi.fn<(key: string) => string | undefined>()
}))

vi.mock('../../store', () => ({
  storeGet: store.get,
  secureGet: store.secureGet
}))

import {
  ASR_API_KEY_STORE_KEY,
  ASR_BASE_URL_STORE_KEY,
  ASR_MODEL_STORE_KEY,
  resolveASRConfig
} from '../config-store'

describe('ASR 安全配置契约', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.ECHO_ASR_API_KEY
    delete process.env.ECHO_ASR_BASE_URL
    delete process.env.ECHO_ASR_MODEL
  })

  afterEach(() => {
    delete process.env.ECHO_ASR_API_KEY
    delete process.env.ECHO_ASR_BASE_URL
    delete process.env.ECHO_ASR_MODEL
  })

  it('没有凭证时明确拒绝启动，不携带任何硬编码密钥', () => {
    expect(() => resolveASRConfig()).toThrow(/尚未配置 API Key/)
  })

  it('从系统安全存储读取密钥，并使用非敏感默认地址和模型', () => {
    store.secureGet.mockImplementation((key) => key === ASR_API_KEY_STORE_KEY ? 'secret' : undefined)
    expect(resolveASRConfig()).toEqual({
      baseUrl: 'https://api.siliconflow.cn/v1/audio/transcriptions',
      model: 'TeleAI/TeleSpeechASR',
      apiKey: 'secret'
    })
  })

  it('读取用户设置的地址和模型', () => {
    store.secureGet.mockReturnValue('secret')
    store.get.mockImplementation((key) => {
      if (key === ASR_BASE_URL_STORE_KEY) return 'https://asr.example.com/transcribe'
      if (key === ASR_MODEL_STORE_KEY) return 'corp-asr-v2'
      return undefined
    })
    expect(resolveASRConfig()).toEqual({
      baseUrl: 'https://asr.example.com/transcribe',
      model: 'corp-asr-v2',
      apiKey: 'secret'
    })
  })

  it('受管环境变量优先于本地设置', () => {
    store.secureGet.mockReturnValue('local-secret')
    store.get.mockReturnValue('local-setting')
    process.env.ECHO_ASR_API_KEY = 'managed-secret'
    process.env.ECHO_ASR_BASE_URL = 'https://managed.example.com/asr'
    process.env.ECHO_ASR_MODEL = 'managed-model'
    expect(resolveASRConfig()).toEqual({
      baseUrl: 'https://managed.example.com/asr',
      model: 'managed-model',
      apiKey: 'managed-secret'
    })
  })

  it('拒绝把密钥发往非本机 HTTP 地址，但允许回环开发服务', () => {
    store.secureGet.mockReturnValue('secret')
    process.env.ECHO_ASR_BASE_URL = 'http://asr.example.com/transcribe'
    expect(() => resolveASRConfig()).toThrow(/必须使用 HTTPS/)

    process.env.ECHO_ASR_BASE_URL = 'http://127.0.0.1:9000/transcribe'
    expect(resolveASRConfig().baseUrl).toBe('http://127.0.0.1:9000/transcribe')
  })
})
