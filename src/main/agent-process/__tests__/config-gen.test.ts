import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let kv: Record<string, unknown> = {}
vi.mock('../../store', () => ({
  storeGet: (k: string) => kv[k],
  storeSet: (k: string, v: unknown) => {
    kv[k] = v
  }
}))
vi.mock('electron', () => ({
  app: {
    getPath: () => os.tmpdir(),
    getAppPath: () => os.tmpdir(),
    isPackaged: false
  }
}))

import { generateAgentConfig, readAgentConfig } from '../config-gen'
import { AGENT_CONFIG_PATH } from '../constants'

const baseConfig = { defaultModel: 'gpt-4o', providers: [{ name: 'openai' as const }] }

beforeEach(() => {
  kv = {}
  if (fs.existsSync(AGENT_CONFIG_PATH)) fs.rmSync(AGENT_CONFIG_PATH)
})

describe('generateAgentConfig 按档位写 tools 段', () => {
  it('full 档: restrict_to_workspace false + profile full', () => {
    kv['agent.scope'] = 'full'
    generateAgentConfig(baseConfig)
    const yaml = fs.readFileSync(AGENT_CONFIG_PATH, 'utf-8')
    expect(yaml).toContain('restrict_to_workspace: false')
    expect(yaml).toContain('profile: "full"')
  })

  it('restricted 档: restrict_to_workspace true + profile coding + workspace 指向选定目录', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-'))
    kv['agent.scope'] = 'restricted'
    kv['agent.workspaceDir'] = dir
    generateAgentConfig(baseConfig)
    const yaml = fs.readFileSync(AGENT_CONFIG_PATH, 'utf-8')
    expect(yaml).toContain('restrict_to_workspace: true')
    expect(yaml).toContain('profile: "coding"')
    expect(yaml).toContain(`workspace: "${dir}"`)
  })

  it('文件权限为 0600', () => {
    kv['agent.scope'] = 'full'
    generateAgentConfig(baseConfig)
    const mode = fs.statSync(AGENT_CONFIG_PATH).mode & 0o777
    // Windows 不支持 POSIX 权限位, 跳过断言
    if (process.platform !== 'win32') expect(mode).toBe(0o600)
  })
})

describe('readAgentConfig 无损回读 provider 字段', () => {
  it('回读 apiBase/apiKey/models 与写入一致', () => {
    kv['agent.scope'] = 'full'
    generateAgentConfig({
      defaultModel: 'gpt-4o',
      providers: [
        {
          name: 'openai',
          apiBase: 'https://api.example.com/v1',
          apiKey: 'sk-secret-123',
          models: ['gpt-4o']
        }
      ]
    })
    const cfg = readAgentConfig()
    expect(cfg).not.toBeNull()
    expect(cfg!.defaultModel).toBe('gpt-4o')
    expect(cfg!.providers).toHaveLength(1)
    expect(cfg!.providers[0].name).toBe('openai')
    expect(cfg!.providers[0].apiBase).toBe('https://api.example.com/v1')
    expect(cfg!.providers[0].apiKey).toBe('sk-secret-123')
    expect(cfg!.providers[0].models).toEqual(['gpt-4o'])
  })

  it('多 provider 各自字段不串台', () => {
    kv['agent.scope'] = 'full'
    generateAgentConfig({
      defaultModel: 'gpt-4o',
      providers: [
        { name: 'openai', apiBase: 'https://openai.example/v1', apiKey: 'sk-a', models: ['gpt-4o'] },
        { name: 'anthropic', apiBase: 'https://anthropic.example', apiKey: 'sk-b' }
      ]
    })
    const cfg = readAgentConfig()!
    expect(cfg.providers).toHaveLength(2)
    expect(cfg.providers[0]).toMatchObject({
      name: 'openai',
      apiBase: 'https://openai.example/v1',
      apiKey: 'sk-a',
      models: ['gpt-4o']
    })
    expect(cfg.providers[1]).toMatchObject({
      name: 'anthropic',
      apiBase: 'https://anthropic.example',
      apiKey: 'sk-b'
    })
    expect(cfg.providers[1].models).toBeUndefined()
  })

  it('回读后重新生成的 yaml 仍保留 apiBase/apiKey(模拟 set-scope 重生成)', () => {
    kv['agent.scope'] = 'full'
    generateAgentConfig({
      defaultModel: 'gpt-4o',
      providers: [
        { name: 'openai', apiBase: 'https://api.example.com/v1', apiKey: 'sk-secret-123' }
      ]
    })
    const reread = readAgentConfig()!
    // 模拟切换访问范围后用回读结果重生成配置
    kv['agent.scope'] = 'restricted'
    kv['agent.workspaceDir'] = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-'))
    generateAgentConfig(reread)
    const yaml = fs.readFileSync(AGENT_CONFIG_PATH, 'utf-8')
    expect(yaml).toContain('apiBase: "https://api.example.com/v1"')
    expect(yaml).toContain('apiKey: "sk-secret-123"')
  })
})
