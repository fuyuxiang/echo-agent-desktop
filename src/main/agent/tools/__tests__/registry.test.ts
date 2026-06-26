// src/main/agent/tools/__tests__/registry.test.ts
import { describe, it, expect } from 'vitest'
import { ToolRegistry } from '../registry'
import type { Tool } from '../base'

const fakeTool = (name: string): Tool => ({
  name,
  description: `desc ${name}`,
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ ok: true, content: 'x' })
})

describe('ToolRegistry', () => {
  it('register + get + list', () => {
    const r = new ToolRegistry()
    r.register(fakeTool('a'))
    r.register(fakeTool('b'))
    expect(r.get('a')?.name).toBe('a')
    expect(r.list().map((t) => t.name)).toEqual(['a', 'b'])
  })
  it('get 未知工具返回 undefined', () => {
    expect(new ToolRegistry().get('nope')).toBeUndefined()
  })
  it('toSchemas 转成 provider 的 ToolSchema 形态', () => {
    const r = new ToolRegistry()
    r.register(fakeTool('a'))
    expect(r.toSchemas()).toEqual([
      { name: 'a', description: 'desc a', parameters: { type: 'object', properties: {} } }
    ])
  })
  it('重复注册同名工具覆盖', () => {
    const r = new ToolRegistry()
    r.register(fakeTool('a'))
    r.register({ ...fakeTool('a'), description: 'new' })
    expect(r.get('a')?.description).toBe('new')
    expect(r.list()).toHaveLength(1)
  })
})