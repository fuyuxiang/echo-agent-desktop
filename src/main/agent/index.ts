// src/main/agent/index.ts
import type { ChatProvider } from './providers'
import { ToolRegistry } from './tools/registry'
import { SessionManager } from './session/SessionManager'
import { NoopMemoryGateway } from './tools/memory-facade'
import { readFileTool, writeFileTool, listDirTool, editFileTool } from './tools/fs'
import { shellTool } from './tools/shell'
import { webSearchTool, webFetchTool } from './tools/web'
import { AgentRuntime } from './runtime/AgentRuntime'
import { getMemoryManager } from './memory/singleton'
import { getSkillManager } from './skills/singleton'

const DEFAULT_SYSTEM_PROMPT = '你是 Echo 桌面助手,可调用工具完成用户任务。'

/** 装配 P2 首批工具(不含 memory_ 前缀与 skill_ 前缀的工具,P3/P4 各自挂载) */
export function buildDefaultRegistry(): ToolRegistry {
  const r = new ToolRegistry()
  for (const t of [readFileTool, writeFileTool, listDirTool, editFileTool, shellTool, webSearchTool, webFetchTool]) {
    r.register(t)
  }
  return r
}

export function createAgentRuntime(opts: {
  provider: ChatProvider
  model: string
  systemPrompt?: string
  maxToolTurns?: number
}): AgentRuntime {
  return new AgentRuntime({
    provider: opts.provider,
    tools: buildDefaultRegistry(),
    sessions: new SessionManager(),
    memory: getMemoryManager() ?? new NoopMemoryGateway(),
    skills: getSkillManager(),
    systemPrompt: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    model: opts.model,
    maxToolTurns: opts.maxToolTurns
  })
}

export { AgentRuntime } from './runtime/AgentRuntime'
export { ToolRegistry } from './tools/registry'
export { SessionManager } from './session/SessionManager'
export type { RuntimeEvent } from './runtime/events'
