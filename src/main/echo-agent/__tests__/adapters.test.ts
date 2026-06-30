import { describe, it, expect } from 'vitest'
import { buildGatewayArgs, buildGatewayEnv, createLineBuffer } from '../adapters'

describe('gateway spawn assembly', () => {
  it('buildGatewayArgs 走 gateway 子命令,显式 loopback + port=0 + 配置/工作区', () => {
    expect(buildGatewayArgs('/home/u/.echo-agent/echo-agent.yaml', '/home/u/.echo-agent')).toEqual([
      '-m', 'echo_agent', 'gateway',
      '-c', '/home/u/.echo-agent/echo-agent.yaml',
      '-w', '/home/u/.echo-agent',
      '--host', '127.0.0.1',
      '--port', '0'
    ])
  })

  it('buildGatewayEnv 保留原 env,不再注入无效的顶层 ECHO_AGENT_* 端口/令牌', () => {
    const env = buildGatewayEnv({ PATH: '/bin' })
    expect(env.PATH).toBe('/bin')
    // echo-agent 的 env 映射是 ECHO_AGENT_GATEWAY__PORT 双下划线嵌套;
    // 旧的顶层 ECHO_AGENT_PORT/HOST/API_TOKEN 它根本不认,不应再注入
    expect(env.ECHO_AGENT_PORT).toBeUndefined()
    expect(env.ECHO_AGENT_HOST).toBeUndefined()
    expect(env.ECHO_AGENT_API_TOKEN).toBeUndefined()
  })
})

describe('createLineBuffer', () => {
  it('按换行切分,缓冲半行直到下一个 chunk 补全', () => {
    const lines: string[] = []
    const push = createLineBuffer((l) => lines.push(l))
    push('ECHO_AGENT_READY port=42 ws=/ws health=/api/v1/health\nGateway list')
    push('ening on 127.0.0.1:42\n')
    expect(lines).toEqual([
      'ECHO_AGENT_READY port=42 ws=/ws health=/api/v1/health',
      'Gateway listening on 127.0.0.1:42'
    ])
  })

  it('单 chunk 多行', () => {
    const lines: string[] = []
    const push = createLineBuffer((l) => lines.push(l))
    push('a\nb\nc\n')
    expect(lines).toEqual(['a', 'b', 'c'])
  })

  it('无换行时不发射(继续缓冲)', () => {
    const lines: string[] = []
    const push = createLineBuffer((l) => lines.push(l))
    push('partial line no newline')
    expect(lines).toEqual([])
  })
})
