// src/main/agent/tools/shell.ts
import { spawn } from 'node:child_process'
import type { Tool, ToolContext, ToolResult } from './base'
import { resolveWorkspace } from './scope'

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_OUTPUT_BYTES = 64 * 1024

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
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const command = String(args.command ?? '')
    const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : DEFAULT_TIMEOUT_MS
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
      const child = spawn(command, { shell: true, cwd })
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
