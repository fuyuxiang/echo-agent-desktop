import { describe, it, expect } from 'vitest'
import { parseReadySignal } from '../ready-signal'

describe('parseReadySignal', () => {
  it('解析标准 ready 信号(默认前缀)', () => {
    const r = parseReadySignal('ECHO_AGENT_READY port=51234 ws=/ws health=/api/v1/health')
    expect(r).toEqual({ port: 51234, wsPath: '/ws', apiPrefix: '/api/v1' })
  })

  it('port=0 自动分配后回报的真实端口', () => {
    const r = parseReadySignal('ECHO_AGENT_READY port=8 ws=/ws health=/api/v1/health')
    expect(r?.port).toBe(8)
  })

  it('从 health 字段去掉尾部 /health 得 apiPrefix', () => {
    const r = parseReadySignal('ECHO_AGENT_READY port=9000 ws=/socket health=/api/health')
    expect(r).toEqual({ port: 9000, wsPath: '/socket', apiPrefix: '/api' })
  })

  it('信号行前后带噪音(loguru 前缀/时间戳)仍能命中', () => {
    const line = '2026-06-30 10:00:00 | INFO | ECHO_AGENT_READY port=42 ws=/ws health=/api/v1/health'
    expect(parseReadySignal(line)?.port).toBe(42)
  })

  it('非 ready 行返回 null', () => {
    expect(parseReadySignal('Gateway listening on 127.0.0.1:51234')).toBeNull()
    expect(parseReadySignal('')).toBeNull()
    expect(parseReadySignal('ECHO_AGENT_READY port=abc ws=/ws health=/api/v1/health')).toBeNull()
  })
})
