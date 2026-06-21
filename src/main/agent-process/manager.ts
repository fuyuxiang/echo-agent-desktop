import { spawn, type ChildProcess } from 'child_process'
import http from 'http'
import { log } from '../logger'
import {
  PYTHON_BIN,
  AGENT_CONFIG_PATH,
  AGENT_WORKSPACE,
  READY_SIGNAL_PREFIX,
  HEALTH_CHECK_TIMEOUT,
  MAX_RESTART_ATTEMPTS,
  SHUTDOWN_TIMEOUT,
  RESTART_STABLE_RESET_MS,
  SIGKILL_GRACE_MS
} from './constants'
import { checkHealth } from './health'
import { getEnvInfo } from './python-env'
import { hasAgentConfig } from './config-gen'
import type { AgentProcessStatus, AgentStartResult } from '@shared/types'

let agentProcess: ChildProcess | null = null
let currentPort: number | null = null
let currentStatus: AgentProcessStatus = 'stopped'
let restartCount = 0
let statusChangeCallback: ((status: AgentProcessStatus) => void) | null = null

/**
 * 主动停止守卫: stopAgent 期间置位, 防止 proc.exit 的自动重启逻辑误判为"崩溃"而拉起新进程。
 */
let stopping = false

/** 稳定运行计时器: 进程稳定运行一段时间后归零重启计数, 避免长期运行后偶发崩溃被旧计数拖入 error 态 */
let stableResetTimer: ReturnType<typeof setTimeout> | null = null

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

function clearStableResetTimer(): void {
  if (stableResetTimer) {
    clearTimeout(stableResetTimer)
    stableResetTimer = null
  }
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

  // 新一轮显式启动: 解除停止守卫并重置重启计数
  stopping = false
  restartCount = 0

  setStatus('starting')

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

  // 解析 stdout 等待就绪信号(按行缓冲: 就绪信号可能被拆分到多个 data chunk)
  const port = await waitForReadySignal(proc)

  // 进程已被替换(并发重启)或已被主动停止: 放弃本次结果, 由新流程接管
  if (agentProcess !== proc) {
    return { success: false, error: '启动已被新的启动/停止操作取代' }
  }

  if (!port) {
    setStatus('error')
    kill()
    return { success: false, error: `启动超时: ${Math.round(HEALTH_CHECK_TIMEOUT / 1000)}秒内未收到就绪信号` }
  }

  currentPort = port
  setStatus('running')
  log.info(`[agent] 启动成功, port=${port}`)

  // 稳定运行一段时间后归零重启计数(区分"崩溃循环"与"长期运行后的偶发崩溃")
  clearStableResetTimer()
  stableResetTimer = setTimeout(() => {
    restartCount = 0
    stableResetTimer = null
  }, RESTART_STABLE_RESET_MS)

  // 监听退出，自动重启(仅在非主动停止、当前归属本进程时)
  proc.on('exit', (code) => {
    // 已被替换为新进程: 旧进程退出与状态机无关
    if (agentProcess !== proc) return

    clearStableResetTimer()
    log.warn(`[agent] 进程退出, code=${code}`)

    if (stopping) {
      // 主动停止流程会自行收尾, 这里不介入
      return
    }

    if (restartCount < MAX_RESTART_ATTEMPTS) {
      restartCount++
      log.info(`[agent] 自动重启 (${restartCount}/${MAX_RESTART_ATTEMPTS})`)
      setStatus('starting')
      void doSpawn(apiKeys)
    } else {
      log.error(`[agent] 已达最大重启次数(${MAX_RESTART_ATTEMPTS}), 放弃重启`)
      currentPort = null
      agentProcess = null
      setStatus('error')
    }
  })

  return { success: true, port }
}

/** 解析 stdout 就绪信号, 返回端口; 超时/进程退出/出错返回 null。按行缓冲避免信号被 chunk 拆断。 */
function waitForReadySignal(proc: ChildProcess): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    let resolved = false
    let stdoutBuf = ''

    const finish = (value: number | null): void => {
      if (resolved) return
      resolved = true
      clearTimeout(timeout)
      proc.stdout?.off('data', onStdout)
      proc.off('error', onError)
      proc.off('exit', onExit)
      resolve(value)
    }

    const timeout = setTimeout(() => finish(null), HEALTH_CHECK_TIMEOUT)

    const onStdout = (data: Buffer): void => {
      stdoutBuf += data.toString()
      let idx: number
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx)
        stdoutBuf = stdoutBuf.slice(idx + 1)
        log.debug(`[agent:stdout] ${line.trim()}`)
        if (line.includes(READY_SIGNAL_PREFIX)) {
          const match = line.match(/port=(\d+)/)
          if (match) {
            finish(parseInt(match[1], 10))
            return
          }
        }
      }
      // 行内信号(无换行结尾)也尝试匹配, 兼容 agent 不带换行直接 flush 的情况
      if (stdoutBuf.includes(READY_SIGNAL_PREFIX)) {
        const match = stdoutBuf.match(/port=(\d+)/)
        if (match) finish(parseInt(match[1], 10))
      }
    }

    const onError = (): void => finish(null)
    const onExit = (): void => finish(null)

    proc.stdout?.on('data', onStdout)
    proc.stderr?.on('data', (data: Buffer) => {
      log.debug(`[agent:stderr] ${data.toString().trim()}`)
    })
    proc.on('error', onError)
    proc.on('exit', onExit)
  })
}

/** 停止 Agent 进程(主动停止: 阻止自动重启, 优雅关闭失败再强杀) */
export async function stopAgent(): Promise<void> {
  stopping = true
  clearStableResetTimer()

  if (!agentProcess && !currentPort) {
    setStatus('stopped')
    stopping = false
    return
  }

  const proc = agentProcess

  // 尝试优雅关闭（通过 API）
  if (currentPort) {
    try {
      await httpPost(`http://127.0.0.1:${currentPort}/api/v1/shutdown`)
      // 等待进程退出
      await new Promise<void>((resolve) => {
        if (!proc || proc.exitCode !== null) {
          resolve()
          return
        }
        const timeout = setTimeout(resolve, SHUTDOWN_TIMEOUT)
        proc.once('exit', () => {
          clearTimeout(timeout)
          resolve()
        })
      })
    } catch {
      log.warn('[agent] shutdown API 调用失败，直接 kill')
    }
  }

  kill()
  setStatus('stopped')
  stopping = false
}

/** 重启 */
export async function restartAgent(apiKeys?: Record<string, string>): Promise<AgentStartResult> {
  await stopAgent()
  return startAgent(apiKeys)
}

function kill(): void {
  const proc = agentProcess
  // 先解除全局引用, 防止 exit handler 把本次 kill 误判为崩溃
  agentProcess = null
  currentPort = null
  if (!proc || proc.exitCode !== null) return

  try {
    if (process.platform === 'win32') {
      if (proc.pid) {
        spawn('taskkill', ['/T', '/F', '/PID', String(proc.pid)])
      }
    } else {
      proc.kill('SIGTERM')
      // 宽限期后若仍存活则强杀(在被捕获的 proc 引用上执行, 不依赖已被置空的全局引用)
      setTimeout(() => {
        if (proc.exitCode === null) proc.kill('SIGKILL')
      }, SIGKILL_GRACE_MS)
    }
  } catch (e) {
    log.error('[agent] kill 失败:', e)
  }
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
