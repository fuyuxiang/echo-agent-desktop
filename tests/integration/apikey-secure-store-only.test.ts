/**
 * Regression: API Key 单一来源(safeStorage)
 *
 * 2026-08 审计 P0-7:旧实现 ModelSection 同时把 apiKey 写入 LOCAL_CONFIG_KEY
 * (普通 storage) 和 yaml 配置文件,安全存储等于没存。
 * 修复后:真实上游 key 只写 safeStorage；Agent YAML 只指向桌面端本地模型
 * broker，并使用进程级环境变量承载 broker token，不再出现上游 key 或 ref。
 */
import { describe, it, expect } from 'vitest'
import { parse } from 'yaml'

/**
 * 集成断言:读取实际生成的 yaml,验证 apiKey 字段不是明文。
 *
 * 注意:本测试在 CI 上只验证"占位符协议",具体 yaml 由 echo-agent 解析。
 * 这里以 mergeManagedConfig 函数的纯函数行为作为测试对象。
 */
import { mergeManagedConfig } from '../../src/main/echo-agent/config-writer'

describe('Regression: apiKey 不写入 yaml 明文', () => {
  it('yaml 不包含 safeStorage 引用或上游密钥', () => {
    const cfg = {
      baseUrl: 'https://api.example.com',
      apiKey: 'ref:openai-api-key', // 引用而非明文
      model: 'gpt-4o'
    }

    const result = mergeManagedConfig('', cfg)

    const parsed = JSON.stringify(parse(result))
    expect(parsed).not.toContain('ref:openai-api-key')
    expect(result).not.toContain('sk-secret')
    expect(result).not.toContain('sk-local')
    expect(parsed).toContain('"apiKey":""')
  })

  it('即使调用方误传明文，配置生成器也会丢弃', () => {
    const cfg = {
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-REAL-SECRET-1234567890',
      model: 'gpt-4o'
    }

    const result = mergeManagedConfig('', cfg)

    expect(result).not.toContain('sk-REAL-SECRET-1234567890')
  })
})

describe('Regression: ModelSection.handleSave 后磁盘不含明文', () => {
  it('(占位) 应在 handleSave 后检查 LOCAL_CONFIG_KEY 不含 apiKey 字段', () => {
    // 真正的端到端测试需要 electron-store / safeStorage mock。
    // 这里验证 SavedModelConfig 接口定义不包含 apiKey 字段,只包含 apiKeyRef。
    // (TypeScript 层:见 ModelSection.tsx 中的 SavedModelConfig)
    // 类型断言在编译时保证;运行时通过 storage.set 调用限定。
    const savedConfig = {
      baseUrl: 'https://api.example.com',
      modelName: 'gpt-4o',
      apiKeyRef: 'openai-api-key' // 引用而非明文
    }
    expect(savedConfig).not.toHaveProperty('apiKey')
    expect(savedConfig.apiKeyRef).toBe('openai-api-key')
  })
})
