import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// 内存 KV 模拟 electron-store
let kv: Record<string, unknown> = {}
vi.mock('../../store', () => ({
  storeGet: (k: string) => kv[k],
  storeSet: (k: string, v: unknown) => {
    kv[k] = v
  }
}))

// constants 依赖 electron app.*,mock 掉
vi.mock('electron', () => ({
  app: {
    getPath: () => os.tmpdir(),
    getAppPath: () => os.tmpdir(),
    isPackaged: false
  }
}))

import { getScopeConfig, setScopeConfig, resolveWorkspace } from '../scope'
import { DEFAULT_AGENT_WORKSPACE } from '../constants'

beforeEach(() => {
  kv = {}
})

describe('scope 配置门面', () => {
  it('无记录时默认 full', () => {
    expect(getScopeConfig()).toEqual({ scope: 'full', workspaceDir: '' })
  })

  it('setScopeConfig 写入后可读回', () => {
    setScopeConfig({ scope: 'restricted', workspaceDir: '/tmp/proj' })
    expect(getScopeConfig()).toEqual({ scope: 'restricted', workspaceDir: '/tmp/proj' })
  })

  it('full 档 resolveWorkspace 返回默认目录', () => {
    setScopeConfig({ scope: 'full', workspaceDir: '' })
    expect(resolveWorkspace()).toBe(DEFAULT_AGENT_WORKSPACE)
  })

  it('restricted 且目录存在 resolveWorkspace 返回该目录', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-'))
    setScopeConfig({ scope: 'restricted', workspaceDir: dir })
    expect(resolveWorkspace()).toBe(dir)
  })

  it('restricted 但目录不存在 resolveWorkspace 回退默认目录', () => {
    setScopeConfig({ scope: 'restricted', workspaceDir: '/no/such/dir/xyz' })
    expect(resolveWorkspace()).toBe(DEFAULT_AGENT_WORKSPACE)
  })
})
