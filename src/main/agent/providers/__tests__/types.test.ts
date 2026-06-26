import { describe, it, expect } from 'vitest'
import type { ChatDelta, ChatMessage } from '../types'

describe('provider types', () => {
  it('ChatDelta 联合类型可按 type 收窄', () => {
    const deltas: ChatDelta[] = [
      { type: 'text', text: 'hi' },
      { type: 'reasoning', text: '思考' },
      { type: 'tool_call', index: 0, name: 'read_file', argumentsDelta: '{' },
      { type: 'usage', promptTokens: 10 },
      { type: 'done', finishReason: 'stop' },
      { type: 'error', message: 'boom' }
    ]
    const texts = deltas.filter((d) => d.type === 'text').map((d) => (d as { text: string }).text)
    expect(texts).toEqual(['hi'])
  })

  it('ChatMessage 支持 tool 角色字段', () => {
    const msg: ChatMessage = { role: 'tool', content: 'result', toolCallId: 'call_1', name: 'shell' }
    expect(msg.toolCallId).toBe('call_1')
  })
})
