// src/main/agent/runtime/__tests__/AgentRuntime.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentRuntime, type AgentRuntimeDeps } from '../AgentRuntime'
import { ToolRegistry } from '../../tools/registry'
import { NoopMemoryGateway } from '../../tools/memory-facade'
import { NoopSkillGateway } from '../../tools/skill-facade'
import type { ChatDelta, ChatProvider } from '../../providers'
import type { RuntimeEvent } from '../events'
import type { Tool } from '../../tools/base'

function providerFrom(scripts: ChatDelta[][]): ChatProvider {
  let call = 0
  return {
    name: 'mock',
    async *chat() {
      const deltas = scripts[call] ?? [{ type: 'done' as const }]
      call++
      for (const d of deltas) yield d
    }
  }
}

const sessions = {
  acquire: vi.fn(() => new AbortController()),
  release: vi.fn(),
  abort: vi.fn(),
  isBusy: vi.fn(() => false),
  history: vi.fn(() => []),
  appendMessage: vi.fn((i) => ({ id: 1, ...i, reasoning: null, createdAt: 0 }))
}

function deps(provider: ChatProvider, tools = new ToolRegistry()): AgentRuntimeDeps {
  return {
    provider,
    tools,
    sessions: sessions as unknown as AgentRuntimeDeps['sessions'],
    memory: new NoopMemoryGateway(),
    skills: new NoopSkillGateway(),
    systemPrompt: 'SYS',
    model: 'm'
  }
}

beforeEach(() => vi.clearAllMocks())

describe('AgentRuntime 纯文本轮', () => {
  it('text delta 吐 streaming 并以 final 收尾', async () => {
    const provider = providerFrom([
      [{ type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' }, { type: 'done' }]
    ])
    const rt = new AgentRuntime(deps(provider))
    const evs: RuntimeEvent[] = []
    rt.on((e) => evs.push(e))
    await rt.send('c1', 'hi')
    const stream = evs.filter((e) => e.type === 'streaming').map((e) => (e as { delta: string }).delta)
    expect(stream.join('')).toBe('Hello')
    const final = evs.find((e) => e.type === 'final') as { text: string }
    expect(final.text).toBe('Hello')
    expect(evs[evs.length - 1].type).toBe('done')
  })
  it('busy 时 emit error + done', async () => {
    sessions.acquire.mockReturnValueOnce(null as unknown as AbortController)
    const rt = new AgentRuntime(deps(providerFrom([])))
    const evs: RuntimeEvent[] = []
    rt.on((e) => evs.push(e))
    await rt.send('c1', 'hi')
    expect(evs.some((e) => e.type === 'error')).toBe(true)
    expect(evs[evs.length - 1].type).toBe('done')
  })
})

const okTool = (name: string): Tool => ({
  name,
  description: 'd',
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ ok: true, content: `${name}-result` })
})

describe('AgentRuntime 工具循环', () => {
  it('一轮 tool_call 执行后回灌并二轮 final', async () => {
    const provider = providerFrom([
      [
        { type: 'tool_call', index: 0, id: 't1', name: 'shell', argumentsDelta: '{"command":"ls"}' },
        { type: 'done', finishReason: 'tool_calls' }
      ],
      [{ type: 'text', text: 'done' }, { type: 'done' }]
    ])
    const tools = new ToolRegistry()
    tools.register(okTool('shell'))
    const rt = new AgentRuntime(deps(provider, tools))
    const evs: RuntimeEvent[] = []
    rt.on((e) => evs.push(e))
    await rt.send('c1', 'run ls')
    const progress = evs.filter((e) => e.type === 'progress')
    expect(progress.some((e) => (e as { progressType: string }).progressType === 'tool_call')).toBe(true)
    expect(progress.some((e) => (e as { progressType: string }).progressType === 'tool_result')).toBe(true)
    expect((evs.find((e) => e.type === 'final') as { text: string }).text).toBe('done')
  })

  it('达 maxToolTurns 上限 emit error', async () => {
    // 每轮都吐一个 tool_call,永不收敛
    const provider: ChatProvider = {
      name: 'loop',
      async *chat() {
        yield { type: 'tool_call', index: 0, id: 't', name: 'shell', argumentsDelta: '{}' }
        yield { type: 'done', finishReason: 'tool_calls' }
      }
    }
    const tools = new ToolRegistry()
    tools.register(okTool('shell'))
    const d = deps(provider, tools)
    d.maxToolTurns = 3
    const rt = new AgentRuntime(d)
    const evs: RuntimeEvent[] = []
    rt.on((e) => evs.push(e))
    await rt.send('c1', 'x')
    expect(evs.some((e) => e.type === 'error')).toBe(true)
    expect(evs[evs.length - 1].type).toBe('done')
  })

  it('工具抛错转 tool_result(ok:false)不崩,循环继续', async () => {
    const provider = providerFrom([
      [{ type: 'tool_call', index: 0, id: 't1', name: 'bad', argumentsDelta: '{}' }, { type: 'done' }],
      [{ type: 'text', text: 'recovered' }, { type: 'done' }]
    ])
    const tools = new ToolRegistry()
    tools.register({
      name: 'bad',
      description: 'd',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        throw new Error('boom')
      }
    })
    const rt = new AgentRuntime(deps(provider, tools))
    const evs: RuntimeEvent[] = []
    rt.on((e) => evs.push(e))
    await rt.send('c1', 'x')
    const tr = evs.find(
      (e) => e.type === 'progress' && (e as { progressType: string }).progressType === 'tool_result'
    ) as { ok: boolean }
    expect(tr.ok).toBe(false)
    expect((evs.find((e) => e.type === 'final') as { text: string }).text).toBe('recovered')
  })

  it('provider 抛错 emit error 不抛出', async () => {
    const provider: ChatProvider = {
      name: 'err',
      // eslint-disable-next-line require-yield
      async *chat() {
        throw new Error('network down')
      }
    }
    const rt = new AgentRuntime(deps(provider))
    const evs: RuntimeEvent[] = []
    rt.on((e) => evs.push(e))
    await expect(rt.send('c1', 'x')).resolves.toBeUndefined()
    expect(evs.some((e) => e.type === 'error')).toBe(true)
  })
})

describe('AgentRuntime capture 接线', () => {
  it('final 后 fire-and-forget 调用 memory.capture 一次', async () => {
    const provider = providerFrom([[{ type: 'text', text: 'ok' }, { type: 'done' }]])
    const d = deps(provider)
    const captureSpy = vi.spyOn(d.memory, 'capture')
    const rt = new AgentRuntime(d)
    await rt.send('c1', 'hi')
    expect(captureSpy).toHaveBeenCalledTimes(1)
    expect(captureSpy.mock.calls[0][0]).toBe('c1')
  })

  it('capture 抛错不影响对话 final/done', async () => {
    const provider = providerFrom([[{ type: 'text', text: 'ok' }, { type: 'done' }]])
    const d = deps(provider)
    vi.spyOn(d.memory, 'capture').mockRejectedValue(new Error('boom'))
    const rt = new AgentRuntime(d)
    const evs: RuntimeEvent[] = []
    rt.on((e) => evs.push(e))
    await rt.send('c1', 'hi')
    expect(evs.some((e) => e.type === 'final')).toBe(true)
    expect(evs[evs.length - 1].type).toBe('done')
  })
})

describe('AgentRuntime 动态工具表(激活技能)', () => {
  it('激活技能的工具进入请求工具表并可被调用', async () => {
    const skillTool: Tool = {
      name: 'generate_ppt',
      description: 'd',
      parameters: { type: 'object', properties: {} },
      async execute() { return { ok: true, content: 'PPT_DONE' } }
    }
    const skills = {
      activePromptFragments: (_c: string) => [],
      tools: (chatId: string) => (chatId === 'c1' ? [skillTool] : [])
    }
    // 第一轮: 模型发起 generate_ppt 工具调用; 第二轮: 纯文本收尾
    const provider = providerFrom([
      [{ type: 'tool_call', index: 0, id: 't1', name: 'generate_ppt', argumentsDelta: '{}' }, { type: 'done' }],
      [{ type: 'text', text: '完成' }, { type: 'done' }]
    ])
    const d = { ...deps(provider), skills }
    const rt = new AgentRuntime(d)
    const evs: RuntimeEvent[] = []
    rt.on((e) => evs.push(e))
    await rt.send('c1', '做个 PPT')
    const toolResult = evs.find(
      (e) => e.type === 'progress' && (e as { progressType?: string }).progressType === 'tool_result'
    ) as { resultText: string }
    expect(toolResult.resultText).toBe('PPT_DONE')
  })
})