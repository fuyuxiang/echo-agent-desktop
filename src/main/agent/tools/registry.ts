// src/main/agent/tools/registry.ts
import type { ToolSchema } from '../providers'
import type { Tool } from './base'

/** 工具注册表: 注册/查找/列出 + 转 provider ToolSchema */
export class ToolRegistry {
  private tools = new Map<string, Tool>()

  register(tool: Tool): void {
    this.tools.set(tool.name, tool)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  list(): Tool[] {
    return [...this.tools.values()]
  }

  toSchemas(): ToolSchema[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }))
  }
}