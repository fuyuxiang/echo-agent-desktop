import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { timingSafeEqual } from 'node:crypto'
import { modelBrokerToken } from './security-tokens'

export type ModelBrokerTarget =
  | { kind: 'direct'; baseUrl: string; apiKey: string }
  | { kind: 'enterprise' }

let target: ModelBrokerTarget | null = null
let server: Server | null = null
let baseUrl = ''
let starting: Promise<string> | null = null
let enterpriseModelChat: ((body: string, signal: AbortSignal) => Promise<Response>) | null = null

/**
 * 企业模型转发由企业模块显式注入。Broker 不反向 import IPC 层，避免
 * echo-agent -> model-broker -> ipc/org -> echo-agent 的循环初始化链。
 */
export function setEnterpriseModelChat(
  handler: ((body: string, signal: AbortSignal) => Promise<Response>) | null
): void {
  enterpriseModelChat = handler
}

function tokenMatches(header: string | undefined): boolean {
  const supplied = header?.replace(/^Bearer\s+/i, '') ?? ''
  const a = Buffer.from(supplied)
  const b = Buffer.from(modelBrokerToken)
  return a.length === b.length && timingSafeEqual(a, b)
}

function completionUrl(base: string): string {
  const normalized = base.replace(/\/$/, '')
  return normalized.endsWith('/chat/completions')
    ? normalized
    : `${normalized}/chat/completions`
}

async function readBody(req: IncomingMessage, maxBytes = 2 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify({ error: { message, type: 'desktop_model_broker_error' } }))
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST' || req.url?.split('?')[0] !== '/v1/chat/completions') {
    jsonError(res, 404, 'not found')
    return
  }
  if (!tokenMatches(req.headers.authorization)) {
    jsonError(res, 401, 'unauthorized')
    return
  }
  if (!target) {
    jsonError(res, 503, 'model broker is not configured')
    return
  }

  const ctrl = new AbortController()
  const abort = (): void => {
    if (!res.writableEnded) ctrl.abort()
  }
  req.once('aborted', abort)
  res.once('close', abort)
  try {
    const body = await readBody(req)
    const upstream =
      target.kind === 'enterprise'
        ? await (() => {
            if (!enterpriseModelChat) throw new Error('enterprise client is not initialized')
            return enterpriseModelChat(body, ctrl.signal)
          })()
        : await fetch(completionUrl(target.baseUrl), {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${target.apiKey}`
            },
            body,
            signal: ctrl.signal
          })

    res.statusCode = upstream.status
    for (const name of ['content-type', 'cache-control', 'x-request-id']) {
      const value = upstream.headers.get(name)
      if (value) res.setHeader(name, value)
    }
    if (!upstream.body) {
      res.end()
      return
    }
    const reader = upstream.body.getReader()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (!res.write(Buffer.from(value))) await once(res, 'drain')
      }
    } finally {
      reader.releaseLock()
    }
    if (!res.writableEnded) res.end()
  } catch (e) {
    if (!res.headersSent) {
      jsonError(
        res,
        ctrl.signal.aborted ? 499 : 502,
        e instanceof Error ? e.message : String(e)
      )
    } else if (!res.writableEnded) {
      res.end()
    }
  } finally {
    req.off('aborted', abort)
    res.off('close', abort)
  }
}

async function ensureStarted(): Promise<string> {
  if (baseUrl) return baseUrl
  if (starting) return starting
  starting = new Promise<string>((resolve, reject) => {
    const next = createServer((req, res) => {
      void handle(req, res)
    })
    next.once('error', reject)
    next.listen(0, '127.0.0.1', () => {
      const address = next.address()
      if (!address || typeof address === 'string') {
        next.close()
        reject(new Error('model broker failed to acquire a loopback port'))
        return
      }
      server = next
      baseUrl = `http://127.0.0.1:${address.port}`
      resolve(baseUrl)
    })
  }).finally(() => {
    starting = null
  })
  return starting
}

export async function configureModelBroker(
  nextTarget: ModelBrokerTarget
): Promise<{ baseUrl: string; token: string }> {
  target = nextTarget
  return { baseUrl: await ensureStarted(), token: modelBrokerToken }
}

export async function stopModelBroker(): Promise<void> {
  target = null
  baseUrl = ''
  const current = server
  server = null
  if (!current) return
  current.closeAllConnections?.()
  await new Promise<void>((resolve) => current.close(() => resolve()))
}
