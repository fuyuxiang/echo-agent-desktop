import { describe, it, expect, vi } from 'vitest'
import { ensureInstalled, updateEchoAgent, type InstallerDeps } from '../installer'
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

function baseDeps(over: Partial<InstallerDeps> = {}): InstallerDeps {
  const { runner } = fakeRunner()
  return {
    runner, homeDir: '/h', platform: 'darwin', bundledPython: '/res/python3',
    venvExists: () => false, ...over
  }
}

describe('installer', () => {
  it('creates venv with bundled python when missing, then pip installs echo-agent[all]', async () => {
    const { runner, calls } = fakeRunner()
    await ensureInstalled(baseDeps({ runner, venvExists: () => false }))
    expect(calls[0]).toEqual(['/res/python3', '-m', 'venv', '/h/.echo-agent/runtime'])
    const pip = calls.find((c) => c.includes('install') && c.some((a) => a.includes('echo-agent')))
    expect(pip).toBeTruthy()
    expect(pip).toContain('echo-agent[all]')
  })

  it('skips venv creation when venv already exists', async () => {
    const { runner, calls } = fakeRunner()
    await ensureInstalled(baseDeps({ runner, venvExists: () => true }))
    expect(calls.some((c) => c.includes('venv'))).toBe(false)
  })

  it('throws with stderr when pip fails', async () => {
    const runner: CommandRunner = {
      run: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'no network' }))
    }
    await expect(ensureInstalled(baseDeps({ runner, venvExists: () => true })))
      .rejects.toThrow(/no network/)
  })

  it('update runs pip install -U echo-agent', async () => {
    const { runner, calls } = fakeRunner()
    await updateEchoAgent(baseDeps({ runner, venvExists: () => true }))
    const upd = calls.find((c) => c.includes('-U'))
    expect(upd).toContain('echo-agent')
  })
})
