// src/main/agent/tools/fs.ts
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Tool, ToolContext, ToolResult } from './base'
import { assertInScope } from './scope'

const MAX_READ_BYTES = 256 * 1024

function fail(msg: string): ToolResult {
  return { ok: false, content: msg }
}

export const readFileTool: Tool = {
  name: 'read_file',
  description: '读取文件内容(超大文件会截断)',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: '文件路径' } },
    required: ['path']
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const p = String(args.path ?? '')
    const scoped = await assertInScope(p, ctx.workspace)
    if (!scoped.ok) return fail(scoped.reason)
    try {
      const buf = await fs.readFile(scoped.resolved)
      const truncated = buf.byteLength > MAX_READ_BYTES
      const text = buf.subarray(0, MAX_READ_BYTES).toString('utf8')
      return { ok: true, content: text, truncated }
    } catch (e) {
      return fail(`读取失败: ${(e as Error).message}`)
    }
  }
}

export const writeFileTool: Tool = {
  name: 'write_file',
  description: '写入文件(父目录不存在则创建)',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' }
    },
    required: ['path', 'content']
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const p = String(args.path ?? '')
    const scoped = await assertInScope(p, ctx.workspace)
    if (!scoped.ok) return fail(scoped.reason)
    try {
      await fs.mkdir(path.dirname(scoped.resolved), { recursive: true })
      await fs.writeFile(scoped.resolved, String(args.content ?? ''), 'utf8')
      return { ok: true, content: `已写入 ${scoped.resolved}` }
    } catch (e) {
      return fail(`写入失败: ${(e as Error).message}`)
    }
  }
}

export const listDirTool: Tool = {
  name: 'list_dir',
  description: '列出目录下的文件与子目录',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path']
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const p = String(args.path ?? '')
    const scoped = await assertInScope(p, ctx.workspace)
    if (!scoped.ok) return fail(scoped.reason)
    try {
      const entries = await fs.readdir(scoped.resolved, { withFileTypes: true })
      const lines = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      return { ok: true, content: lines.join('\n') }
    } catch (e) {
      return fail(`列目录失败: ${(e as Error).message}`)
    }
  }
}

export const editFileTool: Tool = {
  name: 'edit_file',
  description: '把文件中唯一匹配的 oldText 替换为 newText',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      oldText: { type: 'string' },
      newText: { type: 'string' }
    },
    required: ['path', 'oldText', 'newText']
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const p = String(args.path ?? '')
    const oldText = String(args.oldText ?? '')
    const newText = String(args.newText ?? '')
    const scoped = await assertInScope(p, ctx.workspace)
    if (!scoped.ok) return fail(scoped.reason)
    if (oldText === '') return fail('oldText 不能为空')
    try {
      const text = await fs.readFile(scoped.resolved, 'utf8')
      const first = text.indexOf(oldText)
      if (first === -1) return fail('未找到 oldText')
      if (text.indexOf(oldText, first + oldText.length) !== -1) {
        return fail('oldText 匹配多处,请提供更精确的上下文')
      }
      await fs.writeFile(scoped.resolved, text.replace(oldText, newText), 'utf8')
      return { ok: true, content: `已替换 ${scoped.resolved}` }
    } catch (e) {
      return fail(`编辑失败: ${(e as Error).message}`)
    }
  }
}