import { describe, it, expect, vi } from 'vitest'
import { ensureInstalled, updateEchoAgent, ensurePythonExtracted, DEFAULT_PIP_INDEX, type InstallerDeps } from '../installer'
import type { CommandRunner, CommandResult } from '../types'
import { InstallationAbortedError } from '../types'

function fakeRunner(result: Partial<CommandResult> = {}): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = []
  const runner: CommandRunner = {
    run: vi.fn(async (cmd, args) => {
      calls.push([cmd, ...args])
      return { code: 0, stdout: '', stderr: '', ...result }
    })
  }
  return { runner, calls }
}

// pathExists 桩:默认 archive 存在、解压 python 与 venv 都不存在(全新安装)。
// over.exists 可按路径子串定制。
// 2026-08 P0-安全:coreVersion 必填,baseDeps 默认给个固定值,测试覆盖。
function baseDeps(over: Partial<InstallerDeps> = {}): InstallerDeps {
  const { runner } = fakeRunner()
  return {
    runner,
    homeDir: '/h',
    platform: 'darwin',
    pythonArchive: '/res/python-standalone-mac-arm64.tar.gz',
    pathExists: (p: string) => p.includes('python-standalone'),
    ensureDir: () => {},
    coreVersion: '0.9.4', // 测试默认带显式版本
    ...over
  }
}

describe('installer', () => {
  it('extracts bundled python, creates venv, then pip installs echo-agent[all] with index', async () => {
    const { runner, calls } = fakeRunner()
    const dirs: string[] = []
    await ensureInstalled(baseDeps({ runner, ensureDir: (p) => dirs.push(p) }))
    // 0) 解压前确保目标目录存在(tar -C 不会自动建)
    expect(dirs).toContain('/h/.echo-agent/python')
    // 1) tar 解压 archive 到 ~/.echo-agent/python
    const tar = calls.find((c) => c[0] === 'tar')
    expect(tar).toBeTruthy()
    expect(tar).toContain('/res/python-standalone-mac-arm64.tar.gz')
    expect(tar).toContain('/h/.echo-agent/python')
    // 2) 用解压出的 python 建 venv
    const venv = calls.find((c) => c.includes('venv'))
    expect(venv![0]).toBe('/h/.echo-agent/python/bin/python3')
    expect(venv).toContain('/h/.echo-agent/runtime')
    // 3) pip 用 venv python 装 echo-agent[all]==<pinned>,带默认清华源
    const pip = calls.find((c) => c.includes('install') && c.some((a) => a.includes('echo-agent')))
    expect(pip![0]).toBe('/h/.echo-agent/runtime/bin/python')
    expect(pip).toContain('echo-agent[all]==0.9.4')
    expect(pip).toContain('-i')
    expect(pip).toContain(DEFAULT_PIP_INDEX)
  })

  it('skips extraction when python already extracted', async () => {
    const { runner, calls } = fakeRunner()
    // 解压 python 已存在 → 不应再 tar
    await ensureInstalled(baseDeps({ runner, pathExists: () => true }))
    expect(calls.some((c) => c[0] === 'tar')).toBe(false)
  })

  it('throws when bundled archive missing', async () => {
    const { runner } = fakeRunner()
    // 解压 python 不存在,且 archive 也不存在
    await expect(ensurePythonExtracted(baseDeps({ runner, pathExists: () => false })))
      .rejects.toThrow(/内置 Python 运行时缺失/)
  })

  it('throws with stderr when extraction fails', async () => {
    const runner: CommandRunner = {
      run: vi.fn(async (cmd) => cmd === 'tar'
        ? { code: 1, stdout: '', stderr: 'tar broken' }
        : { code: 0, stdout: '', stderr: '' })
    }
    await expect(ensureInstalled(baseDeps({ runner })))
      .rejects.toThrow(/tar broken/)
  })

  it('skips venv creation when venv already exists', async () => {
    const { runner, calls } = fakeRunner()
    // archive 存在、解压 python 存在、venv 也存在 → 只跑 pip
    await ensureInstalled(baseDeps({ runner, pathExists: () => true }))
    expect(calls.some((c) => c.includes('venv'))).toBe(false)
  })

  it('throws with stderr when venv creation fails', async () => {
    const runner: CommandRunner = {
      run: vi.fn(async (_cmd, args) => args.includes('venv')
        ? { code: 1, stdout: '', stderr: 'venv broken' }
        : { code: 0, stdout: '', stderr: '' })
    }
    await expect(ensureInstalled(baseDeps({ runner })))
      .rejects.toThrow(/venv broken/)
  })

  it('throws with stderr when pip fails', async () => {
    const runner: CommandRunner = {
      run: vi.fn(async (_cmd, args) => args.includes('install')
        ? { code: 1, stdout: '', stderr: 'no network' }
        : { code: 0, stdout: '', stderr: '' })
    }
    await expect(ensureInstalled(baseDeps({ runner, pathExists: () => true })))
      .rejects.toThrow(/no network/)
  })

  it('honors custom pip index url', async () => {
    const { runner, calls } = fakeRunner()
    await ensureInstalled(baseDeps({ runner, pathExists: () => true, pipIndexUrl: 'https://my/simple' }))
    const pip = calls.find((c) => c.includes('install'))
    expect(pip).toContain('https://my/simple')
  })

  it('update runs pip install -U echo-agent[all]==<pinned>', async () => {
    const { runner, calls } = fakeRunner()
    await updateEchoAgent(baseDeps({ runner, pathExists: () => true }))
    const upd = calls.find((c) => c.includes('-U'))
    expect(upd).toContain('echo-agent[all]==0.9.4')
  })
})

describe('installer abort behavior', () => {
  it('throws InstallationAbortedError when signal is already aborted before ensureInstalled', async () => {
    const ac = new AbortController()
    ac.abort()
    const { runner: r } = fakeRunner()
    await expect(ensureInstalled(baseDeps({ runner: r, abortSignal: ac.signal })))
      .rejects.toBeInstanceOf(InstallationAbortedError)
  })

  it('throws InstallationAbortedError when signal is aborted between extraction and venv', async () => {
    const ac = new AbortController()
    // pathExists: only archive exists, extracted python and venv do not exist.
    // This ensures tar actually runs, and ac.abort() is called during it.
    const pathExists = (p: string) => p.includes('python-standalone')
    const run: CommandRunner['run'] = vi.fn(async (cmd) => {
      if (cmd === 'tar') ac.abort()
      return { code: 0, stdout: '', stderr: '' }
    })
    const runner: CommandRunner = { run }
    await expect(ensureInstalled(baseDeps({ runner, pathExists, abortSignal: ac.signal })))
      .rejects.toBeInstanceOf(InstallationAbortedError)
  })

  it('throws InstallationAbortedError when signal is aborted before pip install (during venv creation)', async () => {
    const ac = new AbortController()
    // Extracted python exists → extraction skipped. Venv does NOT exist → venv creation runs.
    // Abort signal during venv creation → check before pip catches it.
    const pathExists = (p: string) => {
      if (p.includes('python-standalone')) return true
      // extracted python exists (but not runtime/venv)
      return p.includes('/python/') && !p.includes('/runtime')
    }
    const run: CommandRunner['run'] = vi.fn(async () => {
      ac.abort()
      return { code: 0, stdout: '', stderr: '' }
    })
    const runner: CommandRunner = { run }
    await expect(ensureInstalled(baseDeps({ runner, pathExists, abortSignal: ac.signal })))
      .rejects.toBeInstanceOf(InstallationAbortedError)
  })

  it('throws InstallationAbortedError when ensurePythonExtracted is called with aborted signal', async () => {
    const ac = new AbortController()
    ac.abort()
    const { runner: r } = fakeRunner()
    await expect(ensurePythonExtracted(baseDeps({ runner: r, abortSignal: ac.signal })))
      .rejects.toBeInstanceOf(InstallationAbortedError)
  })
})

// 企业版把 echo-agent-org 与核心一起装。个人版不装插件 —— echo-agent 的
// entry-points 扫不到它,行为与从未有过插件完全一致。
describe('installer org plugin', () => {
  const pipArgsOf = (calls: string[][]): string[] =>
    calls.find((c) => c.includes('pip') && c.includes('install')) ?? []

  it('installs core only when no org plugin version (personal edition)', async () => {
    const { runner, calls } = fakeRunner()
    await ensureInstalled(baseDeps({ runner, pathExists: () => true }))
    const args = pipArgsOf(calls)
    expect(args).toContain('echo-agent[all]==0.9.4')
    expect(args.some((a) => a.includes('echo-agent-org'))).toBe(false)
  })

  it('installs both packages pinned when org plugin version is set', async () => {
    const { runner, calls } = fakeRunner()
    await ensureInstalled(
      baseDeps({
        runner,
        pathExists: () => true,
        coreVersion: '0.9.4',
        orgPluginVersion: '1.0.2'
      })
    )
    const args = pipArgsOf(calls)
    expect(args).toContain('echo-agent[all]==0.9.4')
    expect(args).toContain('echo-agent-org==1.0.2')
  })

  it('updates both packages together so versions cannot drift apart', async () => {
    const { runner, calls } = fakeRunner()
    await updateEchoAgent(
      baseDeps({ runner, coreVersion: '0.9.4', orgPluginVersion: '1.0.2' })
    )
    const args = pipArgsOf(calls)
    expect(args).toContain('-U')
    expect(args).toContain('echo-agent[all]==0.9.4')
    expect(args).toContain('echo-agent-org==1.0.2')
  })

  // 2026-08 P0-安全:不再支持 unpinned。
  // 旧行为(装 latest)会让离线启动失败、引入供应链攻击面。
  it('Regression: throws when coreVersion is missing (unpinned no longer allowed)', async () => {
    const { runner } = fakeRunner()
    await expect(
      ensureInstalled(baseDeps({ runner, pathExists: () => true, coreVersion: undefined }))
    ).rejects.toThrow(/必须显式锁定 coreVersion/)
  })
})
