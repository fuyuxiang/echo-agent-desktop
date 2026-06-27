import { describe, expect, it } from 'vitest'
import { AgentApiUrls, ApiUrls, ServerApiUrls } from '../urls'
import { BizError, SUCCESS_CODE } from '../types'

describe('request constants and types', () => {
  it('动态 URL helpers encode path 参数', () => {
    expect(AgentApiUrls.sessionDetail('a/b c')).toBe('/api/v1/sessions/a%2Fb%20c')
    expect(AgentApiUrls.sessionMessages('a/b c')).toBe('/api/v1/sessions/a%2Fb%20c/messages')
    expect(AgentApiUrls.memoryDetail('m 1')).toBe('/api/v1/memory/m 1')
    expect(AgentApiUrls.skillDetail('ppt/demo')).toBe('/api/v1/skills/ppt/demo')
    expect(AgentApiUrls.knowledgeDocDelete('/tmp/a b.txt')).toBe(
      '/api/v1/knowledge/documents/%2Ftmp%2Fa%20b.txt'
    )
  })

  it('业务 URL 常量和 BizError 形状稳定', () => {
    expect(SUCCESS_CODE).toBe(0)
    expect(ApiUrls.example.greeting).toBe('/api/example/greeting')
    expect(ServerApiUrls.login).toBe('/api/auth/login')
    const err = new BizError(123, 'bad')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('BizError')
    expect(err.code).toBe(123)
    expect(err.message).toBe('bad')
  })
})
