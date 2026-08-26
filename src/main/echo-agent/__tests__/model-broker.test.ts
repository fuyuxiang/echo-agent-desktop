import { request } from 'node:http'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  configureModelBroker,
  setEnterpriseModelChat,
  stopModelBroker
} from '../model-broker'
import { modelBrokerToken } from '../security-tokens'

function post(
  baseUrl: string,
  body: string,
  token?: string
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = request(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...(token ? { authorization: `Bearer ${token}` } : {})
      }
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
        headers: res.headers
      }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  setEnterpriseModelChat(null)
})

afterAll(async () => {
  await stopModelBroker()
})

describe('model broker', () => {
  it('rejects loopback requests without the per-process bearer token', async () => {
    const { baseUrl } = await configureModelBroker({
      kind: 'direct',
      baseUrl: 'https://models.example/v1',
      apiKey: 'upstream-secret'
    })

    const res = await post(baseUrl, '{}')

    expect(res.status).toBe(401)
    expect(JSON.parse(res.body).error.type).toBe('desktop_model_broker_error')
  })

  it('forwards an authorized direct request without exposing its upstream key to Agent', async () => {
    const upstream = vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
      { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'req-1' } }
    ))
    vi.stubGlobal('fetch', upstream)
    const { baseUrl } = await configureModelBroker({
      kind: 'direct',
      baseUrl: 'https://models.example/v1',
      apiKey: 'upstream-secret'
    })
    const body = JSON.stringify({ model: 'model-a', messages: [] })

    const res = await post(baseUrl, body, modelBrokerToken)

    expect(res.status).toBe(200)
    expect(res.headers['x-request-id']).toBe('req-1')
    expect(JSON.parse(res.body).choices[0].message.content).toBe('ok')
    expect(upstream).toHaveBeenCalledWith(
      'https://models.example/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        body,
        headers: expect.objectContaining({ authorization: 'Bearer upstream-secret' })
      })
    )
  })

  it('uses the explicitly injected enterprise transport', async () => {
    const enterprise = vi.fn(async () => new Response('enterprise-ok', { status: 202 }))
    setEnterpriseModelChat(enterprise)
    const { baseUrl } = await configureModelBroker({ kind: 'enterprise' })

    const res = await post(baseUrl, '{"stream":true}', modelBrokerToken)

    expect(res).toMatchObject({ status: 202, body: 'enterprise-ok' })
    expect(enterprise).toHaveBeenCalledWith('{"stream":true}', expect.any(AbortSignal))
  })
})
