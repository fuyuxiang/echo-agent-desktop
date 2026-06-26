import { describe, it, expect, expectTypeOf } from 'vitest'
import type { RuntimeEvent } from '../events'

describe('RuntimeEvent', () => {
  it('按 type 收窄', () => {
    const evs: RuntimeEvent[] = [
      { type: 'streaming', chatId: 'c', delta: 'a', phase: 'text' },
      { type: 'final', chatId: 'c', text: 'done' },
      { type: 'progress', chatId: 'c', progressType: 'tool_call', toolCallId: 't', name: 'shell' },
      { type: 'error', chatId: 'c', message: 'x' },
      { type: 'done', chatId: 'c' }
    ]
    const finals = evs.filter((e) => e.type === 'final')
    expect(finals).toHaveLength(1)
  })
  it('支持 memory_retrieved progress 变体', () => {
    const e: RuntimeEvent = {
      type: 'progress',
      chatId: 'c1',
      progressType: 'memory_retrieved',
      hits: [{ id: '1', text: '用户喜欢咖啡', score: 0.9 }]
    }
    expectTypeOf(e).toMatchTypeOf<RuntimeEvent>()
  })
})
