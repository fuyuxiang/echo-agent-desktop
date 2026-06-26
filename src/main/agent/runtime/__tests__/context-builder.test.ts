import { describe, it, expect } from 'vitest'
import { buildContext } from '../context-builder'
import { NoopMemoryGateway } from '../../tools/memory-facade'
import { NoopSkillGateway } from '../../tools/skill-facade'
import type { MessageRow } from '../../../db/dao/session'

const row = (p: Partial<MessageRow> & { role: string; content: string }): MessageRow => ({
  id: 0,
  chatId: 'c1',
  reasoning: null,
  createdAt: 0,
  ...p
})

const base = {
  chatId: 'c1',
  systemPrompt: 'SYS',
  userText: 'hi',
  memory: new NoopMemoryGateway(),
  skills: new NoopSkillGateway()
}

describe('buildContext', () => {
  it('首条是 system,末条是本轮 user', async () => {
    const msgs = await buildContext({ ...base, history: [] })
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toContain('SYS')
    expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: 'hi' })
  })
  it('还原 assistant 的 toolCalls 与 tool 轮', async () => {
    const history = [
      row({ role: 'user', content: 'q' }),
      row({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't1', name: 'shell', arguments: '{}' }]
      }),
      row({ role: 'tool', content: 'out', toolCallId: 't1', toolName: 'shell' })
    ]
    const msgs = await buildContext({ ...base, history })
    const asst = msgs.find((m) => m.role === 'assistant')!
    expect(asst.toolCalls).toEqual([{ id: 't1', name: 'shell', arguments: '{}' }])
    const tool = msgs.find((m) => m.role === 'tool')!
    expect(tool.toolCallId).toBe('t1')
    expect(tool.name).toBe('shell')
  })
  it('滑窗按整轮切,不从 assistant+tool 中间断开', async () => {
    // 构造 3 轮,每轮 user+assistant(tool)+tool,限制 2 轮
    const history: MessageRow[] = []
    for (let i = 0; i < 3; i++) {
      history.push(row({ role: 'user', content: `u${i}` }))
      history.push(row({ role: 'assistant', content: '', toolCalls: [{ id: `t${i}`, name: 'shell', arguments: '{}' }] }))
      history.push(row({ role: 'tool', content: 'o', toolCallId: `t${i}`, toolName: 'shell' }))
    }
    const msgs = await buildContext({ ...base, history, maxHistoryTurns: 2 })
    // 第一条历史消息应是某个 user 轮起始,而非半截 tool
    const firstHist = msgs[1]
    expect(firstHist.role).toBe('user')
    expect(firstHist.content).toBe('u1')
  })
})
