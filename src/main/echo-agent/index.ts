import { homedir } from 'node:os'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import log from 'electron-log/main'
import type { EchoAgentEndpoint, EchoAgentStatus } from './types'
import { EchoAgentManager } from './manager'
import { ensureInstalled, updateEchoAgent as pipUpdate } from './installer'
import { waitHealthy } from './health'
import { pickFreePort, generateToken } from './runtime-config'
import { venvDir, bundledPythonPath } from './paths'
import { nodeCommandRunner, spawnGateway, shutdownGateway, fetchHealth } from './adapters'
import { writeModelConfig, type ConfigWriterDeps, type ModelConfigInput } from './config-writer'
import WebSocket from 'ws'
import { GatewayClient, type Frame, type WsLike } from './gateway-client'

export interface StatusBus {
  subscribe: (cb: (s: EchoAgentStatus) => void) => () => void
  emit: (s: EchoAgentStatus) => void
  last: () => EchoAgentStatus
}

export function createStatusBus(): StatusBus {
  const subs = new Set<(s: EchoAgentStatus) => void>()
  let lastStatus: EchoAgentStatus = { phase: 'idle' }
  return {
    subscribe(cb) { subs.add(cb); return () => subs.delete(cb) },
    emit(s) { lastStatus = s; for (const cb of subs) cb(s) },
    last() { return lastStatus }
  }
}

const bus = createStatusBus()
let manager: EchoAgentManager | null = null

export function getEchoAgentManager(): EchoAgentManager {
  if (manager) return manager
  const homeDir = homedir()
  const platform = process.platform
  const arch = process.arch
  const bundledPython = bundledPythonPath(process.resourcesPath, platform, arch)
  manager = new EchoAgentManager({
    ensureInstalled: (onProgress) =>
      ensureInstalled({
        runner: nodeCommandRunner, homeDir, platform, bundledPython,
        venvExists: (dir) => existsSync(dir), onProgress
      }),
    update: (onProgress) =>
      pipUpdate({
        runner: nodeCommandRunner, homeDir, platform, bundledPython,
        venvExists: (dir) => existsSync(dir), onProgress
      }),
    pickPort: pickFreePort,
    genToken: generateToken,
    spawnGateway: ({ port, token }) => spawnGateway({ port, token, homeDir, platform }),
    waitHealthy: (baseUrl) =>
      waitHealthy(baseUrl, { timeoutMs: 120_000, intervalMs: 1000, fetchFn: fetchHealth }),
    shutdown: shutdownGateway,
    onStatus: (s) => { log.info('[echo-agent] status:', s.phase, s.message ?? ''); bus.emit(s) }
  })
  return manager
}

export function getEchoAgentEndpoint(): EchoAgentEndpoint | null {
  return manager?.getEndpoint() ?? null
}

export function onEchoAgentStatus(cb: (s: EchoAgentStatus) => void): () => void {
  cb(bus.last())
  return bus.subscribe(cb)
}

export function getEchoAgentStatus(): EchoAgentStatus {
  return bus.last()
}

export async function startEchoAgent(): Promise<void> { await getEchoAgentManager().start() }
export async function stopEchoAgent(): Promise<void> { await manager?.stop() }
export async function updateEchoAgent(): Promise<void> { await getEchoAgentManager().runUpdate() }

export function buildConfigWriterDeps(): ConfigWriterDeps {
  return {
    homeDir: homedir(),
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, data) => writeFileSync(p, data, 'utf8'),
    ensureDir: (p) => { mkdirSync(p, { recursive: true }) }
  }
}

export async function applyModelConfig(cfg: ModelConfigInput): Promise<void> {
  writeModelConfig(buildConfigWriterDeps(), cfg)
  await getEchoAgentManager().restart()
}

export async function restartEchoAgent(): Promise<void> {
  await getEchoAgentManager().restart()
}

// reference to avoid unused warning (venvDir is reserved for the upcoming config-write plan)
void venvDir

export function buildWsUrl(baseUrl: string, wsPath = '/ws'): string {
  return baseUrl.replace(/^http/, 'ws') + wsPath
}

let gatewayClient: GatewayClient | null = null

export function getGatewayClient(emit: (e: Frame) => void): GatewayClient | null {
  if (gatewayClient) return gatewayClient
  const endpoint = getEchoAgentEndpoint()
  if (!endpoint) return null
  gatewayClient = new GatewayClient({
    wsUrl: buildWsUrl(endpoint.baseUrl),
    token: endpoint.token,
    createWs: (url) => new WebSocket(url) as unknown as WsLike,
    emit
  })
  return gatewayClient
}

export function resetGatewayClient(): void {
  gatewayClient?.disconnect()
  gatewayClient = null
}
