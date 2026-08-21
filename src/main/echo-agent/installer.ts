import { venvDir, venvPython, extractedPython, extractedPythonDir } from './paths'
import type { CommandRunner } from './types'
import { InstallationAbortedError } from './types'

// 默认 pip 镜像源:清华(国内首启成功率高)。可经 deps.pipIndexUrl 覆盖。
export const DEFAULT_PIP_INDEX = 'https://pypi.tuna.tsinghua.edu.cn/simple'
export const BUNDLED_ORG_DISTRIBUTION = 'echo-agent-desktop-org'

export interface InstallerDeps {
  runner: CommandRunner
  homeDir: string
  platform: NodeJS.Platform
  // 随包分发的 Python 运行时压缩包路径(resources/python-standalone-<key>.tar.gz)。
  pythonArchive: string
  // Desktop 内置企业插件源码目录(resources/echo-agent-org)。
  orgPluginPath: string
  // 判定路径是否已存在(注入 existsSync,便于测试)。
  pathExists: (p: string) => boolean
  // 递归创建目录(注入 mkdirSync recursive,跨平台,便于测试)。
  ensureDir: (p: string) => void
  // pip 镜像源,默认 DEFAULT_PIP_INDEX。
  pipIndexUrl?: string
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

// 探测 venv 里是否已装指定 distribution。pip show 退出码 0 = 已装。
async function isPackageInstalled(deps: InstallerDeps, distribution: string): Promise<boolean> {
  if (deps.abortSignal?.aborted) throw new InstallationAbortedError()
  const py = venvPython(deps.homeDir, deps.platform)
  const res = await deps.runner.run(py, ['-m', 'pip', 'show', distribution], {
    signal: deps.abortSignal
  })
  return res.code === 0
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

// 启动期安装/检测:确保 venv 与 Python 就绪 + echo-agent 已装。
//
// 策略:
//   1) 解压 Python、创建 venv(如未就绪)
//   2) 分别用 `pip show` 检测核心与 Desktop 内置企业插件
//   3) 两者都已装 → 直接 return,不再调 pip install
//   4) 核心未装 → pip install echo-agent[all](latest,不锁版本)
//   5) 插件未装 → 从随包资源目录安装;兼容已装核心的存量用户自动补装
//
// 跨进程幂等:第二次启动起,venv、核心和插件都已就绪,只执行两个 pip show。
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
  const coreInstalled = await isPackageInstalled(deps, 'echo-agent')
  const orgInstalled = await isPackageInstalled(deps, BUNDLED_ORG_DISTRIBUTION)
  if (coreInstalled && orgInstalled) {
    deps.onProgress?.('echo-agent 与企业插件已安装,跳过 pip install')
    return
  }
  if (!coreInstalled) {
    await pip(deps, ['install', 'echo-agent[all]'])
  }
  if (!orgInstalled) {
    if (!deps.pathExists(deps.orgPluginPath)) {
      throw new Error(`内置企业插件缺失: ${deps.orgPluginPath}`)
    }
    await pip(deps, ['install', deps.orgPluginPath])
  }
}

// 用户主动触发(设置 → 关于 → 升级):核心升级 latest,并刷新内置插件。
export async function updateEchoAgent(deps: InstallerDeps): Promise<void> {
  if (!deps.pathExists(deps.orgPluginPath)) {
    throw new Error(`内置企业插件缺失: ${deps.orgPluginPath}`)
  }
  await pip(deps, ['install', '-U', 'echo-agent[all]'])
  await pip(deps, ['install', '-U', deps.orgPluginPath])
}
