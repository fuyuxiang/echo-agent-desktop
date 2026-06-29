import { venvDir, venvPython } from './paths'
import type { CommandRunner } from './types'

export interface InstallerDeps {
  runner: CommandRunner
  homeDir: string
  platform: NodeJS.Platform
  bundledPython: string
  venvExists: (dir: string) => boolean
  onProgress?: (line: string) => void
}

async function pip(deps: InstallerDeps, args: string[]): Promise<void> {
  const py = venvPython(deps.homeDir, deps.platform)
  const res = await deps.runner.run(py, ['-m', 'pip', ...args], {
    onStdout: deps.onProgress
  })
  if (res.code !== 0) {
    throw new Error(`pip ${args.join(' ')} 失败: ${res.stderr.slice(0, 500) || `exit ${res.code}`}`)
  }
}

export async function ensureInstalled(deps: InstallerDeps): Promise<void> {
  const dir = venvDir(deps.homeDir)
  if (!deps.venvExists(dir)) {
    const res = await deps.runner.run(deps.bundledPython, ['-m', 'venv', dir])
    if (res.code !== 0) {
      throw new Error(`创建 venv 失败: ${res.stderr.slice(0, 500) || `exit ${res.code}`}`)
    }
  }
  await pip(deps, ['install', 'echo-agent[all]'])
}

export async function updateEchoAgent(deps: InstallerDeps): Promise<void> {
  await pip(deps, ['install', '-U', 'echo-agent'])
}
