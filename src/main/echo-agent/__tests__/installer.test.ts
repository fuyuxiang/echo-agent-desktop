import { describe, it, expect, vi } from 'vitest'
import { ensureInstalled, updateEchoAgent, ensurePythonExtracted, DEFAULT_PIP_INDEX, type InstallerDeps } from '../installer'
import type { CommandRunner, CommandResult } from '../types'

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
function baseDeps(over: Partial<InstallerDeps> = {}): InstallerDeps {
  const { runner } = fakeRunner()
  return {
    runner,
    homeDir: '/h',
    platform: 'darwin',
    pythonArchive: '/res/python-standalone-mac-arm64.tar.gz',
    pathExists: (p: string) => p.includes('python-standalone'),
    ensureDir: () => {},
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
    // 3) pip 用 venv python 装 echo-agent[all],带默认清华源
    const pip = calls.find((c) => c.includes('install') && c.some((a) => a.includes('echo-agent')))
    expect(pip![0]).toBe('/h/.echo-agent/runtime/bin/python')
    expect(pip).toContain('echo-agent[all]')
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

  it('update runs pip install -U echo-agent[all]', async () => {
    const { runner, calls } = fakeRunner()
    await updateEchoAgent(baseDeps({ runner, pathExists: () => true }))
    const upd = calls.find((c) => c.includes('-U'))
    expect(upd).toContain('echo-agent[all]')
  })
})
