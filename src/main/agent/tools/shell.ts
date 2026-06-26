// src/main/agent/tools/shell.ts
import { spawn } from 'node:child_process'
import type { Tool, ToolContext, ToolResult } from './base'
import { resolveWorkspace } from './scope'
import { decide } from '../permission/broker'

const DEFAULT_TIMEOUT_MS = 60_000
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 300_000
const MAX_OUTPUT_BYTES = 64 * 1024

/**
 * 子进程环境变量白名单:只透传 shell 正常运行必需的变量,不继承主进程完整 env。
 * 纵深防御 —— 即便命令被审批放行,也尽量减少其可见的环境(降低 token 残留泄露、PATH 操纵面)。
 * 跨平台:Windows 的 cmd/PowerShell 依赖 SystemRoot/COMSPEC 等才能启动,需一并放行。
 */
const ENV_ALLOWLIST_COMMON = ['PATH', 'Path', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'HOME']
const ENV_ALLOWLIST_WIN = [
  'SystemRoot',
  'SystemDrive',
  'COMSPEC',
  'PATHEXT',
  'WINDIR',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'USERNAME',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMDATA',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE'
]

function buildSafeEnv(): NodeJS.ProcessEnv {
  const keys =
    process.platform === 'win32'
      ? [...ENV_ALLOWLIST_COMMON, ...ENV_ALLOWLIST_WIN]
      : ENV_ALLOWLIST_COMMON
  const env: NodeJS.ProcessEnv = {}
  for (const k of keys) {
    const v = process.env[k]
    if (v !== undefined) env[k] = v
  }
  return env
}

export const shellTool: Tool = {
  name: 'shell',
  description: '在工作目录执行 shell 命令(有超时与输出截断)',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'shell 命令' },
      timeoutMs: { type: 'number', description: '超时毫秒,默认 60000' }
    },
    required: ['command']
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const command = String(args.command ?? '')
    // 权限裁决:受限档下经审批/allowlist 决定是否放行,堵住绕过 scope 的任意命令执行
    const decision = await decide({ kind: 'shell', command }, { chatId: ctx.chatId, signal: ctx.signal })
    if (!decision.allow) return { ok: false, content: decision.reason }
    const rawTimeout = typeof args.timeoutMs === 'number' ? args.timeoutMs : DEFAULT_TIMEOUT_MS
    const timeoutMs = Math.min(Math.max(rawTimeout, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)
    const cwd = ctx.workspace || resolveWorkspace()
    return new Promise<ToolResult>((resolve) => {
      let out = ''
      let settled = false
      const finish = (r: ToolResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        resolve(r)
      }
      const child = spawn(command, { shell: true, cwd, env: buildSafeEnv() })
      const append = (buf: Buffer): void => {
        if (out.length < MAX_OUTPUT_BYTES) out += buf.toString('utf8')
      }
      child.stdout.on('data', append)
      child.stderr.on('data', append)
      const onAbort = (): void => {
        child.kill('SIGKILL')
        finish({ ok: false, content: out + '\n[已中断]' })
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish({ ok: false, content: out + `\n[超时 ${timeoutMs}ms]` })
      }, timeoutMs)
      ctx.signal.addEventListener('abort', onAbort)
      child.on('error', (e) => finish({ ok: false, content: `执行失败: ${e.message}` }))
      child.on('close', (code) => {
        const truncated = out.length >= MAX_OUTPUT_BYTES
        finish({
          ok: code === 0,
          content: out.slice(0, MAX_OUTPUT_BYTES) + (code === 0 ? '' : `\n[退出码 ${code}]`),
          truncated
        })
      })
    })
  }
}
