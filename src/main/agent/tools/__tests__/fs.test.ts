// src/main/agent/tools/__tests__/fs.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ToolContext } from '../base'

let dir: string
const ctx = (): ToolContext => ({
  chatId: 'c1',
  workspace: dir,
  signal: new AbortController().signal,
  onProgress: () => {}
})

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-fs-'))
  vi.resetModules()
  // full 档放行所有路径,聚焦 fs 行为
  vi.doMock('../scope', () => ({ assertInScope: (p: string) => ({ ok: true, resolved: path.resolve(p) }) }))
})

describe('fs tools', () => {
  it('write 然后 read 往返一致', async () => {
    const { writeFileTool, readFileTool } = await import('../fs')
    const f = path.join(dir, 'sub/a.txt')
    await writeFileTool.execute({ path: f, content: 'hello' }, ctx())
    const r = await readFileTool.execute({ path: f }, ctx())
    expect(r.ok).toBe(true)
    expect(r.content).toBe('hello')
  })
  it('list_dir 列出文件', async () => {
    const { writeFileTool, listDirTool } = await import('../fs')
    await writeFileTool.execute({ path: path.join(dir, 'x.txt'), content: '1' }, ctx())
    const r = await listDirTool.execute({ path: dir }, ctx())
    expect(r.content).toContain('x.txt')
  })
  it('edit_file 唯一匹配替换', async () => {
    const { writeFileTool, editFileTool, readFileTool } = await import('../fs')
    const f = path.join(dir, 'e.txt')
    await writeFileTool.execute({ path: f, content: 'foo bar' }, ctx())
    const e = await editFileTool.execute({ path: f, oldText: 'bar', newText: 'baz' }, ctx())
    expect(e.ok).toBe(true)
    expect((await readFileTool.execute({ path: f }, ctx())).content).toBe('foo baz')
  })
  it('edit_file 多次匹配拒绝', async () => {
    const { writeFileTool, editFileTool } = await import('../fs')
    const f = path.join(dir, 'm.txt')
    await writeFileTool.execute({ path: f, content: 'a a a' }, ctx())
    expect((await editFileTool.execute({ path: f, oldText: 'a', newText: 'b' }, ctx())).ok).toBe(false)
  })
  it('read 不存在的文件返回 ok:false 不抛', async () => {
    const { readFileTool } = await import('../fs')
    expect((await readFileTool.execute({ path: path.join(dir, 'nope') }, ctx())).ok).toBe(false)
  })
})