// src/main/agent/runtime/AgentRuntime.ts
import type {
  ChatProvider,
  ChatMessage,
  ChatDelta,
  ToolCall
} from '../providers'
import type { ToolRegistry } from '../tools/registry'
import type { SessionManager } from '../session/SessionManager'
import type { MemoryGateway } from '../tools/memory-facade'
import type { SkillGateway } from '../tools/skill-facade'
import type { ToolContext } from '../tools/base'
import { buildContext } from './context-builder'
import type { RuntimeEvent, RuntimeEventHandler } from './events'

const DEFAULT_MAX_TOOL_TURNS = 25

export interface AgentRuntimeDeps {
  provider: ChatProvider
  tools: ToolRegistry
  sessions: SessionManager
  memory: MemoryGateway
  skills: SkillGateway
  systemPrompt: string
  model: string
  maxToolTurns?: number
}

/** 一轮 provider 流式收集结果 */
interface CollectedTurn {
  content: string
  reasoning: string
  toolCalls: ToolCall[]
}

export class AgentRuntime {
  private handlers = new Set<RuntimeEventHandler>()
  constructor(private deps: AgentRuntimeDeps) {}

  on(h: RuntimeEventHandler): void {
    this.handlers.add(h)
  }
  off(h: RuntimeEventHandler): void {
    this.handlers.delete(h)
  }
  private emit(e: RuntimeEvent): void {
    for (const h of this.handlers) {
      try {
        h(e)
      } catch {
        // 监听器异常不影响 runtime
      }
    }
  }

  abort(chatId: string): void {
    this.deps.sessions.abort(chatId)
  }

  /** 基础 registry + 当前会话激活技能工具合并的工具表 schema */
  private dynamicToolSchemas(chatId: string): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    const all = [...this.deps.tools.list(), ...this.deps.skills.tools(chatId)]
    return all.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
  }

  /** 收集一轮 provider 流;边收边 emit streaming */
  private async collect(
    chatId: string,
    messages: ChatMessage[],
    signal: AbortSignal
  ): Promise<CollectedTurn> {
    const turn: CollectedTurn = { content: '', reasoning: '', toolCalls: [] }
    const byIndex = new Map<number, ToolCall>()
    const req = { model: this.deps.model, messages, tools: this.dynamicToolSchemas(chatId) }
    for await (const d of this.deps.provider.chat(req, signal)) {
      const delta = d as ChatDelta
      if (delta.type === 'text') {
        turn.content += delta.text
        this.emit({ type: 'streaming', chatId, delta: delta.text, phase: 'text' })
      } else if (delta.type === 'reasoning') {
        turn.reasoning += delta.text
        this.emit({ type: 'streaming', chatId, delta: delta.text, phase: 'reasoning' })
      } else if (delta.type === 'tool_call') {
        const cur = byIndex.get(delta.index) ?? { id: '', name: '', arguments: '' }
        if (delta.id) cur.id = delta.id
        if (delta.name) cur.name = delta.name
        if (delta.argumentsDelta) cur.arguments += delta.argumentsDelta
        byIndex.set(delta.index, cur)
      }
    }
    turn.toolCalls = [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
    return turn
  }

  /** 串行执行一轮的工具,返回回灌用的 tool 角色消息 */
  private async runTools(
    chatId: string,
    toolCalls: ToolCall[],
    signal: AbortSignal
  ): Promise<ChatMessage[]> {
    const results: ChatMessage[] = []
    for (const call of toolCalls) {
      this.emit({
        type: 'progress',
        chatId,
        progressType: 'tool_call',
        toolCallId: call.id,
        name: call.name,
        argsText: call.arguments
      })
      let resultText: string
      let ok: boolean
      const tool =
        this.deps.tools.get(call.name) ??
        this.deps.skills.tools(chatId).find((t) => t.name === call.name)
      if (!tool) {
        ok = false
        resultText = `未知工具: ${call.name}`
      } else {
        try {
          const ctx: ToolContext = {
            chatId,
            workspace: '',
            signal,
            onProgress: () => {}
          }
          let args: Record<string, unknown> = {}
          try {
            args = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {}
          } catch {
            args = {}
          }
          const r = await tool.execute(args, ctx)
          ok = r.ok
          resultText = r.content
        } catch (e) {
          ok = false
          resultText = `工具执行异常: ${(e as Error).message}`
        }
      }
      this.emit({
        type: 'progress',
        chatId,
        progressType: 'tool_result',
        toolCallId: call.id,
        name: call.name,
        resultText,
        ok
      })
      this.deps.sessions.appendMessage({
        chatId,
        role: 'tool',
        content: resultText,
        toolCallId: call.id,
        toolName: call.name
      })
      results.push({ role: 'tool', content: resultText, toolCallId: call.id, name: call.name })
    }
    return results
  }

  async send(chatId: string, userText: string): Promise<void> {
    const ac = this.deps.sessions.acquire(chatId)
    if (!ac) {
      this.emit({ type: 'error', chatId, message: '该会话正在处理中,请稍候' })
      this.emit({ type: 'done', chatId })
      return
    }
    const maxTurns = this.deps.maxToolTurns ?? DEFAULT_MAX_TOOL_TURNS
    try {
      this.deps.sessions.appendMessage({ chatId, role: 'user', content: userText })
      const messages = await buildContext({
        chatId,
        systemPrompt: this.deps.systemPrompt,
        history: this.deps.sessions.history(chatId),
        userText,
        memory: this.deps.memory,
        skills: this.deps.skills
      })
      let reachedLimit = true
      for (let turn = 0; turn < maxTurns; turn++) {
        const collected = await this.collect(chatId, messages, ac.signal)
        if (collected.toolCalls.length === 0) {
          this.deps.sessions.appendMessage({
            chatId,
            role: 'assistant',
            content: collected.content,
            reasoning: collected.reasoning || null
          })
          this.emit({
            type: 'final',
            chatId,
            text: collected.content,
            reasoning: collected.reasoning || undefined
          })
          // fire-and-forget: 抽取记忆,不 await、不进会阻断主流程的 catch
          void this.deps.memory
            .capture(chatId, [...messages, { role: 'assistant', content: collected.content }])
            .catch(() => {})
          reachedLimit = false
          break
        }
        this.deps.sessions.appendMessage({
          chatId,
          role: 'assistant',
          content: collected.content,
          reasoning: collected.reasoning || null,
          toolCalls: collected.toolCalls
        })
        messages.push({
          role: 'assistant',
          content: collected.content,
          toolCalls: collected.toolCalls
        })
        const toolMsgs = await this.runTools(chatId, collected.toolCalls, ac.signal)
        messages.push(...toolMsgs)
      }
      if (reachedLimit) {
        this.emit({ type: 'error', chatId, message: `已达最大工具轮数 ${maxTurns}` })
      }
    } catch (e) {
      this.emit({ type: 'error', chatId, message: (e as Error).message })
    } finally {
      this.emit({ type: 'done', chatId })
      this.deps.sessions.release(chatId)
    }
  }
}