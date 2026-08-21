import { describe, it, expect, vi } from 'vitest'
import { ensureInstalled, updateEchoAgent, ensurePythonExtracted, DEFAULT_PIP_INDEX, type InstallerDeps } from '../installer'
import type { CommandRunner, CommandResult } from '../types'
import { InstallationAbortedError } from '../types'

function fakeRunner(opts: {
  result?: Partial<CommandResult>
  coreInstalled?: boolean
  orgInstalled?: boolean
} = {}): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = []
  const runner: CommandRunner = {
    run: vi.fn(async (cmd, args) => {
      calls.push([cmd, ...args])
      const isPipShow = cmd.includes('python') && args?.includes('show')
      if (isPipShow) {
        const name = args[args.indexOf('show') + 1]
        const installed = name === 'echo-agent' ? opts.coreInstalled : opts.orgInstalled
        return installed
          ? { code: 0, stdout: `Name: ${name}\nVersion: 1.0.0`, stderr: '' }
          : { code: 1, stdout: '', stderr: 'Package not found' }
      }
      return { code: 0, stdout: '', stderr: '', ...opts.result }
    })
  }
  return { runner, calls }
}

function baseDeps(over: Partial<InstallerDeps> = {}): InstallerDeps {
  const { runner } = fakeRunner()
  return {
    runner,
    homeDir: '/h',
    platform: 'darwin',
    pythonArchive: '/res/python-standalone-mac-arm64.tar.gz',
    orgPluginPath: '/res/echo-agent-org',
    pathExists: (p: string) => p.includes('python-standalone') || p.includes('echo-agent-org'),
    ensureDir: () => {},
    ...over
  }
}

describe('installer', () => {
  it('extracts bundled python, creates venv, then pip installs echo-agent[all] (latest, no version pin)', async () => {
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
    // 3) pip 用 venv python 装 echo-agent[all](latest,不带 ==),带默认清华源
    const pip = calls.find((c) => c.includes('install') && c.some((a) => a.includes('echo-agent')))
    expect(pip![0]).toBe('/h/.echo-agent/runtime/bin/python')
    expect(pip).toContain('echo-agent[all]')
    expect(pip!.join(' ')).not.toMatch(/echo-agent\[all\]==/)
    expect(pip).toContain('-i')
    expect(pip).toContain(DEFAULT_PIP_INDEX)
  })

  it('skips pip install when core and bundled plugin are already installed', async () => {
    const { runner, calls } = fakeRunner({ coreInstalled: true, orgInstalled: true })
    await ensureInstalled(baseDeps({ runner, pathExists: () => true }))
    // tar 跳过(extracted python 存在)、venv 跳过(venv 存在)、pip install 也跳过
    expect(calls.some((c) => c[0] === 'tar')).toBe(false)
    expect(calls.some((c) => c.includes('venv'))).toBe(false)
    expect(calls.some((c) => c.includes('install') && c.some((a) => a.includes('echo-agent')))).toBe(false)
    const pipShows = calls.filter((c) => c.includes('show'))
    expect(pipShows).toHaveLength(2)
    expect(pipShows[0][0]).toBe('/h/.echo-agent/runtime/bin/python')
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

  it('throws with stderr when pip install fails', async () => {
    const runner: CommandRunner = {
      run: vi.fn(async (_cmd, args) => {
        // 模拟未装 → 触发 pip install
        if (args.includes('show')) return { code: 1, stdout: '', stderr: '' }
        // 模拟 pip install 失败
        if (args.includes('install')) return { code: 1, stdout: '', stderr: 'no network' }
        return { code: 0, stdout: '', stderr: '' }
      })
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

  it('update runs pip install -U echo-agent[all] (latest, no version pin)', async () => {
    const { runner, calls } = fakeRunner()
    await updateEchoAgent(baseDeps({ runner, pathExists: () => true }))
    const upd = calls.find((c) => c.includes('-U'))
    expect(upd).toContain('echo-agent[all]')
    expect(upd!.join(' ')).not.toMatch(/echo-agent\[all\]==/)
  })

  it('update also refreshes the bundled org plugin', async () => {
    const { runner, calls } = fakeRunner()
    await updateEchoAgent(baseDeps({ runner, pathExists: () => true }))
    const updates = calls.filter((c) => c.includes('-U'))
    expect(updates).toHaveLength(2)
    expect(updates[1]).toContain('/res/echo-agent-org')
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

describe('installer bundled org plugin', () => {
  it('installs latest core and bundled plugin on first launch', async () => {
    const { runner, calls } = fakeRunner()
    await ensureInstalled(baseDeps({ runner, pathExists: () => true }))
    const installs = calls.filter((c) => c.includes('pip') && c.includes('install'))
    expect(installs).toHaveLength(2)
    expect(installs[0]).toContain('echo-agent[all]')
    expect(installs[0].join(' ')).not.toMatch(/echo-agent\[all\]==/)
    expect(installs[1]).toContain('/res/echo-agent-org')
  })

  it('adds the bundled plugin for an existing core installation', async () => {
    const { runner, calls } = fakeRunner({ coreInstalled: true, orgInstalled: false })
    await ensureInstalled(baseDeps({ runner, pathExists: () => true }))
    const installs = calls.filter((c) => c.includes('pip') && c.includes('install'))
    expect(installs).toHaveLength(1)
    expect(installs[0]).toContain('/res/echo-agent-org')
    expect(installs[0]).not.toContain('echo-agent[all]')
  })

  it('installs a missing core without reinstalling an existing plugin', async () => {
    const { runner, calls } = fakeRunner({ coreInstalled: false, orgInstalled: true })
    await ensureInstalled(baseDeps({ runner, pathExists: () => true }))
    const installs = calls.filter((c) => c.includes('pip') && c.includes('install'))
    expect(installs).toHaveLength(1)
    expect(installs[0]).toContain('echo-agent[all]')
  })

  it('fails clearly when the bundled plugin resource is absent', async () => {
    const { runner } = fakeRunner({ coreInstalled: true, orgInstalled: false })
    await expect(
      ensureInstalled(baseDeps({ runner, pathExists: (p) => !p.includes('echo-agent-org') }))
    ).rejects.toThrow(/内置企业插件缺失/)
  })
})
