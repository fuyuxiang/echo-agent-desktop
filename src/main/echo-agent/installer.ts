import { venvDir, venvPython, extractedPython, extractedPythonDir } from './paths'
import type { CommandRunner } from './types'
import { InstallationAbortedError } from './types'

// 默认 pip 镜像源:清华(国内首启成功率高)。可经 deps.pipIndexUrl 覆盖。
export const DEFAULT_PIP_INDEX = 'https://pypi.tuna.tsinghua.edu.cn/simple'

export interface InstallerDeps {
  runner: CommandRunner
  homeDir: string
  platform: NodeJS.Platform
  // 随包分发的 Python 运行时压缩包路径(resources/python-standalone-<key>.tar.gz)。
  pythonArchive: string
  // 判定路径是否已存在(注入 existsSync,便于测试)。
  pathExists: (p: string) => boolean
  // 递归创建目录(注入 mkdirSync recursive,跨平台,便于测试)。
  ensureDir: (p: string) => void
  // pip 镜像源,默认 DEFAULT_PIP_INDEX。
  pipIndexUrl?: string
  // 精确锁定的核心版本(如 "0.9.4")。缺省则装最新,仅用于开发。
  coreVersion?: string
  // 企业版插件版本(如 "1.0.2")。缺省 = 个人版,不装插件。
  orgPluginVersion?: string
  onProgress?: (line: string) => void
  // 中止信号:manager 退出时 abort 取消正在运行的子进程。
  abortSignal?: AbortSignal
}

async function pip(deps: InstallerDeps, args: string[]): Promise<void> {
  const py = venvPython(deps.homeDir, deps.platform)
  const index = deps.pipIndexUrl ?? DEFAULT_PIP_INDEX
  const res = await deps.runner.run(py, ['-m', 'pip', ...args, '-i', index], {
    onStdout: deps.onProgress,
    signal: deps.abortSignal
  })
  if (res.code !== 0) {
    throw new Error(`pip ${args.join(' ')} 失败: ${res.stderr.slice(0, 500) || `exit ${res.code}`}`)
  }
}

// 首启把随包分发的 Python 运行时压缩包解压到用户数据区(~/.echo-agent/python)。
// 已解压则跳过。打包资源区只读,故必须解压到可写的用户目录后再建 venv。
export async function ensurePythonExtracted(deps: InstallerDeps): Promise<void> {
  if (deps.abortSignal?.aborted) throw new InstallationAbortedError()
  const py = extractedPython(deps.homeDir, deps.platform)
  if (deps.pathExists(py)) return
  if (!deps.pathExists(deps.pythonArchive)) {
    throw new Error(`内置 Python 运行时缺失: ${deps.pythonArchive}`)
  }
  const dir = extractedPythonDir(deps.homeDir)
  deps.onProgress?.('正在解压 Python 运行时...')
  // tar 的 -C 目标目录须先存在(tar 不会自动创建)。
  deps.ensureDir(dir)
  // 系统 tar 跨平台可用(Win10+ 自带 bsdtar);压缩包顶层为 python/,strip 后落到 dir。
  const res = await deps.runner.run('tar', ['-xzf', deps.pythonArchive, '-C', dir, '--strip-components=1'], {
    onStdout: deps.onProgress,
    signal: deps.abortSignal
  })
  if (res.code !== 0) {
    throw new Error(`解压 Python 运行时失败: ${res.stderr.slice(0, 500) || `exit ${res.code}`}`)
  }
}

export async function ensureInstalled(deps: InstallerDeps): Promise<void> {
  if (deps.abortSignal?.aborted) throw new InstallationAbortedError()
  await ensurePythonExtracted(deps)
  if (deps.abortSignal?.aborted) throw new InstallationAbortedError()
  const dir = venvDir(deps.homeDir)
  if (!deps.pathExists(dir)) {
    const bundledPython = extractedPython(deps.homeDir, deps.platform)
    const res = await deps.runner.run(bundledPython, ['-m', 'venv', dir], { signal: deps.abortSignal })
    if (res.code !== 0) {
      throw new Error(`创建 venv 失败: ${res.stderr.slice(0, 500) || `exit ${res.code}`}`)
    }
  }
  if (deps.abortSignal?.aborted) throw new InstallationAbortedError()
  // 双包精确锁版:范围号会让不同用户机器上装出不同组合,而插件依赖核心的
  // pre_llm_call hook 契约。两个版本一起升,不允许各自漂移。
  await pip(deps, ['install', ...packageSpecs(deps)])
}

export async function updateEchoAgent(deps: InstallerDeps): Promise<void> {
  await pip(deps, ['install', '-U', ...packageSpecs(deps)])
}

// 企业版多装一个 echo-agent-org。个人版不装 —— 插件不存在时 echo-agent
// 行为与从未有过插件完全一致(entry-points 扫不到即跳过)。
function packageSpecs(deps: InstallerDeps): string[] {
  const core = deps.coreVersion ? `echo-agent[all]==${deps.coreVersion}` : 'echo-agent[all]'
  if (!deps.orgPluginVersion) return [core]
  return [core, `echo-agent-org==${deps.orgPluginVersion}`]
}
