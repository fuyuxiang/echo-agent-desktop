import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { log } from '../logger'
import {
  DESKTOP_DATA_DIR,
  PYTHON_DIR,
  VENV_DIR,
  PYTHON_BIN,
  PIP_BIN,
  EMBEDDED_PYTHON_BIN,
  DEFAULT_PIP_INDEX,
  LOGS_DIR
} from './constants'
import type { AgentEnvInfo, InstallProgressEvent } from '@shared/types'

type ProgressCallback = (event: InstallProgressEvent) => void

/** 检查 Python 环境状态 */
export async function getEnvInfo(): Promise<AgentEnvInfo> {
  if (!fs.existsSync(PYTHON_BIN)) {
    return { pythonVersion: null, echoAgentVersion: null, venvPath: null, status: 'not-installed' }
  }

  try {
    const pythonVersion = await runCommand(PYTHON_BIN, ['--version'])
    const echoAgentVersion = await runCommand(PYTHON_BIN, ['-m', 'echo_agent', '--version'])
    return {
      pythonVersion: pythonVersion.trim().replace('Python ', ''),
      echoAgentVersion: echoAgentVersion.trim(),
      venvPath: VENV_DIR,
      status: 'ready'
    }
  } catch {
    return { pythonVersion: null, echoAgentVersion: null, venvPath: VENV_DIR, status: 'broken' }
  }
}

/** 初始化完整环境（首次安装） */
export async function initializeEnvironment(
  onProgress: ProgressCallback,
  pipIndex?: string
): Promise<void> {
  log.info('[python-env] 开始初始化 Python 环境')
  fs.mkdirSync(DESKTOP_DATA_DIR, { recursive: true })
  fs.mkdirSync(LOGS_DIR, { recursive: true })

  // Stage 1: 解压 Python
  onProgress({ stage: 'python', progress: 0, message: '正在解压 Python 运行时...' })
  await extractPython()
  onProgress({ stage: 'python', progress: 100, message: 'Python 解压完成' })

  // Stage 2: 创建 venv
  onProgress({ stage: 'venv', progress: 0, message: '正在创建虚拟环境...' })
  await createVenv()
  onProgress({ stage: 'venv', progress: 100, message: '虚拟环境创建完成' })

  // Stage 3: pip install
  onProgress({ stage: 'pip', progress: 0, message: '正在安装 echo-agent...' })
  await pipInstall(pipIndex ?? DEFAULT_PIP_INDEX, onProgress)
  onProgress({ stage: 'pip', progress: 100, message: 'echo-agent 安装完成' })

  // Stage 4: 验证
  onProgress({ stage: 'verify', progress: 0, message: '正在验证安装...' })
  const info = await getEnvInfo()
  if (info.status !== 'ready') {
    throw new Error('环境验证失败: echo-agent 不可用')
  }
  onProgress({ stage: 'verify', progress: 100, message: `验证通过 v${info.echoAgentVersion}` })
}

/** 解压内嵌 Python 到 PYTHON_DIR */
async function extractPython(): Promise<void> {
  if (fs.existsSync(EMBEDDED_PYTHON_BIN)) return

  // 查找打包时附带的 Python 压缩包
  const resourcesDir = process.resourcesPath ?? path.join(__dirname, '../../resources')
  const archiveName =
    process.platform === 'win32' ? 'python-embed-win.zip' : 'python-standalone-mac.tar.gz'
  const archivePath = path.join(resourcesDir, archiveName)

  if (!fs.existsSync(archivePath)) {
    throw new Error(`内嵌 Python 包不存在: ${archivePath}`)
  }

  fs.mkdirSync(PYTHON_DIR, { recursive: true })

  if (process.platform === 'win32') {
    await runCommand('powershell', [
      '-Command',
      `Expand-Archive -Path "${archivePath}" -DestinationPath "${PYTHON_DIR}" -Force`
    ])
  } else {
    await runCommand('tar', ['-xzf', archivePath, '-C', PYTHON_DIR, '--strip-components=1'])
  }
}

/** 创建虚拟环境 */
async function createVenv(): Promise<void> {
  if (fs.existsSync(PYTHON_BIN)) return
  await runCommand(EMBEDDED_PYTHON_BIN, ['-m', 'venv', VENV_DIR])
}

/** pip install echo-agent */
async function pipInstall(indexUrl: string, onProgress: ProgressCallback): Promise<void> {
  const logFile = path.join(LOGS_DIR, `pip-install-${Date.now()}.log`)
  const args = ['install', 'echo-agent[allproviders]', '-i', indexUrl, '--log', logFile]

  await runCommandWithProgress(PIP_BIN, args, (line) => {
    if (line.includes('Collecting') || line.includes('Downloading') || line.includes('Installing')) {
      onProgress({ stage: 'pip', progress: 50, message: line.trim() })
    }
  })
}

/** 升级 echo-agent */
export async function upgradeEchoAgent(pipIndex?: string): Promise<string> {
  const args = [
    'install',
    '--upgrade',
    'echo-agent[allproviders]',
    '-i',
    pipIndex ?? DEFAULT_PIP_INDEX
  ]
  await runCommand(PIP_BIN, args)
  const info = await getEnvInfo()
  return info.echoAgentVersion ?? 'unknown'
}

/** 重置环境（删除 venv 重建） */
export async function resetEnvironment(
  onProgress: ProgressCallback,
  pipIndex?: string
): Promise<void> {
  log.info('[python-env] 开始重置 Python 环境')
  if (fs.existsSync(VENV_DIR)) {
    fs.rmSync(VENV_DIR, { recursive: true, force: true })
  }
  await createVenv()
  onProgress({ stage: 'pip', progress: 0, message: '正在重新安装 echo-agent...' })
  await pipInstall(pipIndex ?? DEFAULT_PIP_INDEX, onProgress)
  onProgress({ stage: 'verify', progress: 100, message: '环境重置完成' })
}

/** 检查磁盘空间（至少需要 500MB） */
export function checkDiskSpace(): { available: boolean; freeBytes: number } {
  try {
    const root = DESKTOP_DATA_DIR.split(path.sep).slice(0, 2).join(path.sep) || '/'
    const stats = fs.statfsSync(root)
    const freeBytes = stats.bavail * stats.bsize
    return { available: freeBytes > 500 * 1024 * 1024, freeBytes }
  } catch {
    return { available: true, freeBytes: -1 }
  }
}

// ===== 工具函数 =====

function runCommand(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    proc.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`Command failed (${code}): ${cmd} ${args.join(' ')}\n${stderr}`))
    })
    proc.on('error', reject)
  })
}

function runCommandWithProgress(
  cmd: string,
  args: string[],
  onLine: (line: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stdout.on('data', (d) => {
      d.toString()
        .split('\n')
        .filter(Boolean)
        .forEach(onLine)
    })
    proc.stderr.on('data', (d) => {
      stderr += d.toString()
      d.toString()
        .split('\n')
        .filter(Boolean)
        .forEach(onLine)
    })
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Install failed (${code}):\n${stderr.slice(-2000)}`))
    })
    proc.on('error', reject)
  })
}
