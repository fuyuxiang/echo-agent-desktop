import { describe, it, expect } from 'vitest'
import { isReady, type EchoAgentStatus } from '../types'

describe('echo-agent types', () => {
  it('isReady true only for ready phase with port', () => {
    expect(isReady({ phase: 'ready', port: 51234 })).toBe(true)
  })
  it('isReady false when not ready', () => {
    const cases: EchoAgentStatus[] = [
      { phase: 'starting' },
      { phase: 'ready' }, // 缺 port
      { phase: 'error', message: 'x' }
    ]
    for (const s of cases) expect(isReady(s)).toBe(false)
  })
})
