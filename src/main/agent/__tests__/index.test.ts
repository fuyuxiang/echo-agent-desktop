// src/main/agent/__tests__/index.test.ts
import { describe, it, expect, vi } from 'vitest'
import os from 'node:os'

// web 工具间接依赖 electron-store,node 环境需 mock 掉
vi.mock('electron', () => ({
  app: {
    getPath: () => os.tmpdir(),
    getAppPath: () => os.tmpdir(),
    isPackaged: false
  },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('electron-store', () => ({
  default: class FakeStore {
    get(): undefined {
      return undefined
    }
    set(): void {}
    delete(): void {}
    clear(): void {}
  }
}))

import { buildDefaultRegistry } from '../index'

describe('buildDefaultRegistry', () => {
  it('注册 fs/shell/web 七个工具,不含 memory_/skill_', () => {
    const names = buildDefaultRegistry()
      .list()
      .map((t) => t.name)
      .sort()
    expect(names).toEqual(
      ['edit_file', 'list_dir', 'read_file', 'shell', 'web_fetch', 'web_search', 'write_file'].sort()
    )
    expect(names.some((n) => n.startsWith('memory_') || n.startsWith('skill_'))).toBe(false)
  })
})
