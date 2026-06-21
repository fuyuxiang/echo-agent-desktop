import { spawn, type ChildProcess } from 'child_process'
import http from 'http'
import { log } from '../logger'
import {
  PYTHON_BIN,
  AGENT_CONFIG_PATH,
  AGENT_WORKSPACE,
  READY_SIGNAL_PREFIX,
  HEALTH_CHECK_TIMEOUT,
  HEALTH_CHECK_INTERVAL,
  MAX_RESTART_ATTEMPTS,
  SHUTDOWN_TIMEOUT
} from './constants'
import { waitForHealth, checkHealth } from './health'
import { getEnvInfo } from './python-env'
import { hasAgentConfig } from './config-gen'
import type { AgentProcessStatus, AgentStartResult } from '@shared/types'

let agentProcess: ChildProcess | null = null
let currentPort: number | null = null
let currentStatus: AgentProcessStatus = 'stopped'
let restartCount = 0
let statusChangeCallback: ((status: AgentProcessStatus) => void) | null = null

export function getStatus(): AgentProcessStatus {
  return currentStatus
}

export function getPort(): number | null {
  return currentPort
}

export function onStatusChange(cb: (status: AgentProcessStatus) => void): void {
  statusChangeCallback = cb
}

function setStatus(status: AgentProcessStatus): void {
  currentStatus = status
  statusChangeCallback?.(status)
}

let startInFlight: Promise<AgentStartResult> | null = null

/** 启动 Agent 进程(幂等: 并发/重复调用复用同一次启动, 避免重复 spawn 多个进程) */
export async function startAgent(apiKeys?: Record<string, string>): Promise<AgentStartResult> {
  if (currentStatus === 'running' && currentPort) {
    const alive = await checkHealth(currentPort)
    if (alive) return { success: true, port: currentPort }
  }

  // 已有启动进行中(starting), 复用之, 不再 spawn 新进程
  if (startInFlight) {
    return startInFlight
  }

  startInFlight = doStart(apiKeys).finally(() => {
    startInFlight = null
  })
  return startInFlight
}

async function doStart(apiKeys?: Record<string, string>): Promise<AgentStartResult> {
  const envInfo = await getEnvInfo()
  if (envInfo.status !== 'ready') {
    return { success: false, error: 'Python 环境未就绪，请先完成初始化' }
  }

  if (!hasAgentConfig()) {
    return { success: false, error: '配置文件不存在，请先完成初始设置' }
  }

  setStatus('starting')
  restartCount = 0

  return doSpawn(apiKeys)
}

async function doSpawn(apiKeys?: Record<string, string>): Promise<AgentStartResult> {
  // 剔除继承自用户环境的代理变量: 本地 agent 直连模型厂商, 不应走用户机器的本地代理
  // (否则在配了 SOCKS/HTTP 代理的机器上, agent 的 httpx 会因代理不可用/缺 socksio 而初始化失败)
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(cleanEnv)) {
    if (/^(all|http|https|ftp|no)_proxy$/i.test(k)) delete cleanEnv[k]
  }

  const env = {
    ...cleanEnv,
    ECHO_AGENT_DISABLE_LAZY_INSTALLS: '1',
    ...apiKeys
  }

  const args = ['run', '-c', AGENT_CONFIG_PATH, '-w', AGENT_WORKSPACE]

  log.info(`[agent] Spawning: ${PYTHON_BIN} -m echo_agent ${args.join(' ')}`)

  const proc = spawn(PYTHON_BIN, ['-m', 'echo_agent', ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  })

  agentProcess = proc

  // 解析 stdout 等待就绪信号
  const portPromise = new Promise<number | null>((resolve) => {
    const timeout = setTimeout(() => resolve(null), HEALTH_CHECK_TIMEOUT)
    let resolved = false

    proc.stdout?.on('data', (data: Buffer) => {
      const line = data.toString()
      log.debug(`[agent:stdout] ${line.trim()}`)

      if (!resolved && line.includes(READY_SIGNAL_PREFIX)) {
        const match = line.match(/port=(\d+)/)
        if (match) {
          resolved = true
          clearTimeout(timeout)
          resolve(parseInt(match[1], 10))
        }
      }
    })
    proc.stderr?.on('data', (data: Buffer) => {
      log.debug(`[agent:stderr] ${data.toString().trim()}`)
    })

    proc.on('error', () => {
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        resolve(null)
      }
    })

    proc.on('exit', () => {
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        resolve(null)
      }
    })
  })

  // 等待就绪信号或 fallback 到 health check
  let port = await portPromise

  if (!port) {
    // fallback: 尝试默认端口 9000 的 health check
    log.warn('[agent] 未收到就绪信号，fallback 到 health check 轮询')
    const healthy = await waitForHealth(9000, HEALTH_CHECK_TIMEOUT, HEALTH_CHECK_INTERVAL)
    if (healthy) port = 9000
  }

  if (!port) {
    setStatus('error')
    kill()
    return { success: false, error: '启动超时: 30秒内未收到就绪信号' }
  }

  currentPort = port
  setStatus('running')
  log.info(`[agent] 启动成功, port=${port}`)

  // 监听退出，自动重启
  proc.on('exit', (code) => {
    log.warn(`[agent] 进程退出, code=${code}`)
    if (currentStatus === 'running' && restartCount < MAX_RESTART_ATTEMPTS) {
      restartCount++
      log.info(`[agent] 自动重启 (${restartCount}/${MAX_RESTART_ATTEMPTS})`)
      setStatus('starting')
      doSpawn(apiKeys)
    } else if (currentStatus !== 'stopped') {
      setStatus('error')
    }
  })

  return { success: true, port }
}
/** 停止 Agent 进程 */
export async function stopAgent(): Promise<void> {
  if (!agentProcess && !currentPort) {
    setStatus('stopped')
    return
  }

  // 尝试优雅关闭（通过 API）
  if (currentPort) {
    try {
      await httpPost(`http://127.0.0.1:${currentPort}/api/v1/shutdown`)
      // 等待进程退出
      const exitPromise = new Promise<void>((resolve) => {
        const timeout = setTimeout(() => resolve(), SHUTDOWN_TIMEOUT)
        if (agentProcess) {
          agentProcess.on('exit', () => {
            clearTimeout(timeout)
            resolve()
          })
        } else {
          clearTimeout(timeout)
          resolve()
        }
      })
      await exitPromise
    } catch {
      log.warn('[agent] shutdown API 调用失败，直接 kill')
    }
  }

  kill()
  setStatus('stopped')
}

/** 重启 */
export async function restartAgent(apiKeys?: Record<string, string>): Promise<AgentStartResult> {
  await stopAgent()
  return startAgent(apiKeys)
}

function kill(): void {
  if (!agentProcess) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/T', '/F', '/PID', String(agentProcess.pid)])
    } else {
      agentProcess.kill('SIGTERM')
      setTimeout(() => {
        agentProcess?.kill('SIGKILL')
      }, 5000)
    }
  } catch (e) {
    log.error('[agent] kill 失败:', e)
  }
  agentProcess = null
  currentPort = null
}

function httpPost(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST' }, (res) => {
      res.resume()
      res.on('end', () => resolve())
    })
    req.on('error', reject)
    req.setTimeout(5000, () => {
      req.destroy()
      reject(new Error('timeout'))
    })
    req.end()
  })
}
