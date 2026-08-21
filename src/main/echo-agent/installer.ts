import { venvDir, venvPython, extractedPython, extractedPythonDir } from './paths'
import type { CommandRunner } from './types'
import { InstallationAbortedError } from './types'

// 默认 pip 镜像源:清华(国内首启成功率高)。可经 deps.pipIndexUrl 覆盖。
export const DEFAULT_PIP_INDEX = 'https://pypi.tuna.tsinghua.edu.cn/simple'

// `orgPluginVersion` 的特殊值:未指定具体版本时传此值,代表"装最新"。
// 与 undefined 区分(undefined = 个人版,不装插件;具体版本 = 锁版)。
export const ORG_PLUGIN_LATEST = 'latest'

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
  // 核心包版本策略:
  //   - 未设置:装 latest(`pip install echo-agent[all]`)
  //   - 已设置:锁到指定版本(escape hatch:CI / 紧急回滚通过 ECHO_AGENT_VERSION env 注入)
  coreVersion?: string
  // 企业版插件版本策略:
  //   - undefined:个人版,不装插件
  //   - ORG_PLUGIN_LATEST('latest'):装最新
  //   - 其它字符串:锁到指定版本
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

// 探测 venv 里是否已装 echo-agent。pip show 退出码 0 = 已装。
async function isEchoAgentInstalled(deps: InstallerDeps): Promise<boolean> {
  if (deps.abortSignal?.aborted) throw new InstallationAbortedError()
  const py = venvPython(deps.homeDir, deps.platform)
  const res = await deps.runner.run(py, ['-m', 'pip', 'show', 'echo-agent'], {
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
//   2) 用 `pip show echo-agent` 检测是否已装
//   3) 已装 → 直接 return,不再调 pip install(避免每次启动都打 pypi 索引)
//   4) 未装 → pip install echo-agent[all](默认 latest;env 注入 coreVersion 则锁版)
//
// 跨进程幂等:第二次启动起,venv 已建、echo-agent 已装,整个函数除了一个
// pip show 子进程以外什么都不做。
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
  // 已装就跳过:启动期不再触发 pip install。
  // 升级路径在设置 → 关于 手动跑 updateEchoAgent,与启动期解耦。
  if (await isEchoAgentInstalled(deps)) {
    deps.onProgress?.('echo-agent 已安装,跳过 pip install')
    return
  }
  await pip(deps, ['install', ...packageSpecs(deps)])
}

// 用户主动触发(设置 → 关于 → 升级):无条件 -U 重装/升级。
export async function updateEchoAgent(deps: InstallerDeps): Promise<void> {
  await pip(deps, ['install', '-U', ...packageSpecs(deps)])
}

// 企业版多装一个 echo-agent-org。个人版不装 —— 插件不存在时 echo-agent
// 行为与从未有过插件完全一致(entry-points 扫不到即跳过)。
//
// 版本策略(2026-08 修订):
//   - 默认装 latest(env 未注入 ECHO_AGENT_VERSION 时)
//   - env 显式注入 → 锁到指定版本,用于 CI / 紧急回滚
//   - 装 latest 的副作用已在前置的 isEchoAgentInstalled 检测后避免
//     (启动期不再触发,只有 About 页面"升级"按钮会跑这条路径)
function packageSpecs(deps: InstallerDeps): string[] {
  const core = deps.coreVersion ? `echo-agent[all]==${deps.coreVersion}` : 'echo-agent[all]'
  if (!deps.orgPluginVersion) return [core]
  const org = deps.orgPluginVersion === ORG_PLUGIN_LATEST
    ? 'echo-agent-org'
    : `echo-agent-org==${deps.orgPluginVersion}`
  return [core, org]
}
