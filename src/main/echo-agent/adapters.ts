import { spawn } from 'node:child_process'
import type { CommandRunner, CommandResult, EchoAgentEndpoint } from './types'
import type { SpawnedProc } from './manager'
import { venvPython } from './paths'

export const nodeCommandRunner: CommandRunner = {
  run(cmd, args, opts) {
    return new Promise<CommandResult>((resolve) => {
      const child = spawn(cmd, args, { cwd: opts?.cwd, env: { ...process.env, ...opts?.env } })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d: Buffer) => {
        const s = d.toString()
        stdout += s
        opts?.onStdout?.(s)
      })
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
      child.on('error', (e) => resolve({ code: -1, stdout, stderr: stderr + String(e) }))
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    })
  }
}

export function buildGatewayArgs(configPath: string, workspace: string): string[] {
  // gateway 子命令强制开启网关(run_gateway 设 gateway.enabled=True),
  // 显式绑 loopback + port=0 让 OS 分配,实际端口经 stdout ready 信号回报。
  return [
    '-m', 'echo_agent', 'gateway',
    '-c', configPath,
    '-w', workspace,
    '--host', '127.0.0.1',
    '--port', '0'
  ]
}

export function buildGatewayEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // 不再注入顶层 ECHO_AGENT_HOST/PORT/API_TOKEN:echo-agent 的 env 覆盖用双下划线
  // 嵌套(ECHO_AGENT_GATEWAY__PORT),顶层键它不认。端口/绑定改由命令行参数传。
  return { ...base }
}

// 把任意分块到达的 stdout 数据按行切分,半行缓冲到下一个 chunk 补全后再发射。
// gateway 的 ready 信号可能与其他日志同批或被切断,必须按行解析。
export function createLineBuffer(onLine: (line: string) => void): (chunk: string) => void {
  let buf = ''
  return (chunk: string): void => {
    buf += chunk
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, idx))
      buf = buf.slice(idx + 1)
    }
  }
}

export function spawnGateway(args: {
  configPath: string; workspace: string; homeDir: string; platform: NodeJS.Platform
}): SpawnedProc {
  const py = venvPython(args.homeDir, args.platform)
  const child = spawn(py, buildGatewayArgs(args.configPath, args.workspace), {
    env: buildGatewayEnv(process.env),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  // stderr 仍排空避免 pipe 阻塞;stdout 行通过 onStdoutLine 暴露给 manager 解析 ready 信号
  child.stderr?.on('data', () => {})
  return {
    pid: child.pid ?? -1,
    kill: (signal) => child.kill((signal as NodeJS.Signals) ?? 'SIGTERM'),
    onExit: (cb) => child.on('close', (code) => cb(code)),
    onStdoutLine: (cb) => {
      const push = createLineBuffer(cb)
      child.stdout?.on('data', (d: Buffer) => push(d.toString()))
    }
  }
}

export async function shutdownGateway(endpoint: EchoAgentEndpoint): Promise<void> {
  // bounded request: a hung gateway must not block app exit (stop() has a kill fallback)
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 3000)
  try {
    await fetch(`${endpoint.baseUrl}${endpoint.apiPrefix}/shutdown`, {
      method: 'POST',
      signal: ctrl.signal
    })
  } catch {
    // timeout or network error: swallow, kill fallback handles teardown
  } finally {
    clearTimeout(t)
  }
}

// One-shot HTTP notify to echo-agent. Uses a dedicated chat_id so it never
// rebinds the user's chat WS session. Only short summary text is sent here,
// never the full transcript.
export async function notifyMeeting(endpoint: EchoAgentEndpoint, text: string): Promise<void> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 5000)
  try {
    await fetch(`${endpoint.baseUrl}${endpoint.apiPrefix}/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        platform: 'desktop',
        user_id: 'desktop-user',
        chat_id: 'meeting-notify',
        text
      }),
      signal: ctrl.signal
    })
  } finally {
    clearTimeout(t)
  }
}
