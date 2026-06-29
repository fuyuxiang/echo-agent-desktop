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

export function buildGatewayArgs(): string[] {
  return ['-m', 'echo_agent', 'run']
}

export function buildGatewayEnv(
  args: { port: number; token: string },
  base: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  return {
    ...base,
    ECHO_AGENT_HOST: '127.0.0.1',
    ECHO_AGENT_PORT: String(args.port),
    ECHO_AGENT_API_TOKEN: args.token
  }
}

export function spawnGateway(args: {
  port: number; token: string; homeDir: string; platform: NodeJS.Platform
}): SpawnedProc {
  const py = venvPython(args.homeDir, args.platform)
  const child = spawn(py, buildGatewayArgs(), {
    env: buildGatewayEnv({ port: args.port, token: args.token }, process.env),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  // gateway is long-lived: drain stdout/stderr so the OS pipe buffer (~64KB)
  // never fills up and blocks the child process
  child.stdout?.on('data', () => {})
  child.stderr?.on('data', () => {})
  return {
    pid: child.pid ?? -1,
    kill: (signal) => child.kill((signal as NodeJS.Signals) ?? 'SIGTERM'),
    onExit: (cb) => child.on('close', (code) => cb(code))
  }
}

export async function fetchHealth(url: string): Promise<{ ok: boolean }> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 5000)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    return { ok: res.ok }
  } finally {
    clearTimeout(t)
  }
}

export async function shutdownGateway(endpoint: EchoAgentEndpoint): Promise<void> {
  // bounded request: a hung gateway must not block app exit (stop() has a kill fallback)
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 3000)
  try {
    await fetch(`${endpoint.baseUrl}/api/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${endpoint.token}` },
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
    await fetch(`${endpoint.baseUrl}/api/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${endpoint.token}`
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
