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

import { generateAgentConfig } from '../config-gen'
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
