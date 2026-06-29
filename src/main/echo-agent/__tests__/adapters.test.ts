import { describe, it, expect } from 'vitest'
import { buildGatewayArgs, buildGatewayEnv } from '../adapters'

describe('gateway spawn assembly', () => {
  it('buildGatewayArgs runs echo_agent module', () => {
    expect(buildGatewayArgs()).toEqual(['-m', 'echo_agent', 'run'])
  })
  it('buildGatewayEnv injects loopback host, port, token', () => {
    const env = buildGatewayEnv({ port: 51234, token: 'tok' }, { PATH: '/bin' })
    expect(env.ECHO_AGENT_HOST).toBe('127.0.0.1')
    expect(env.ECHO_AGENT_PORT).toBe('51234')
    expect(env.ECHO_AGENT_API_TOKEN).toBe('tok')
    expect(env.PATH).toBe('/bin') // 保留原 env
  })
})
