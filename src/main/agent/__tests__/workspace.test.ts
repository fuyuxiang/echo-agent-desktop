import { describe, it, expect, vi, beforeEach } from 'vitest'

const store = new Map<string, unknown>()
vi.mock('../../store', () => ({
  storeGet: (k: string) => store.get(k),
  storeSet: (k: string, v: unknown) => void store.set(k, v)
}))
vi.mock('electron', () => ({ app: { getPath: () => '/home/test' } }))
vi.mock('../../logger', () => ({ log: { warn: vi.fn() } }))

import { getScopeConfig, setScopeConfig, DEFAULT_AGENT_WORKSPACE } from '../workspace'

beforeEach(() => store.clear())

describe('workspace scope 配置', () => {
  it('无记录默认 full', () => {
    expect(getScopeConfig()).toEqual({ scope: 'full', workspaceDir: '' })
  })
  it('set 后 get 回读 restricted', () => {
    setScopeConfig({ scope: 'restricted', workspaceDir: '/tmp/ws' })
    expect(getScopeConfig()).toEqual({ scope: 'restricted', workspaceDir: '/tmp/ws' })
  })
  it('DEFAULT_AGENT_WORKSPACE 在 home 下', () => {
    expect(DEFAULT_AGENT_WORKSPACE).toContain('/home/test')
  })
})
