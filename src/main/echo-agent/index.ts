import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { app } from 'electron'
import log from 'electron-log/main'
import type { EchoAgentEndpoint, EchoAgentStatus } from './types'
import { EchoAgentManager } from './manager'
import { ensureInstalled, updateEchoAgent as pipUpdate } from './installer'
import { bundledPythonArchive, configPath, echoHome, venvPython } from './paths'
import { nodeCommandRunner, spawnGateway, shutdownGateway } from './adapters'
import { writeManagedConfig, type ConfigWriterDeps, type ModelConfigInput } from './config-writer'
import WebSocket from 'ws'
import { GatewayClient, type Frame, type WsLike } from './gateway-client'
import { setLLMConfig } from './llm'

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
  // dev 下 process.resourcesPath 指向 Electron 自带 Resources(无我们的资源),
  // 须用项目 resources/;打包后才用 process.resourcesPath。对齐 ASR/diarization 约定。
  const resourcesRoot = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  const pythonArchive = bundledPythonArchive(resourcesRoot, platform, arch)
  manager = new EchoAgentManager({
    ensureInstalled: (onProgress) =>
      ensureInstalled({
        runner: nodeCommandRunner, homeDir, platform, pythonArchive,
        pathExists: (p) => existsSync(p), ensureDir: (p) => { mkdirSync(p, { recursive: true }) }, onProgress
      }),
    update: (onProgress) =>
      pipUpdate({
        runner: nodeCommandRunner, homeDir, platform, pythonArchive,
        pathExists: (p) => existsSync(p), ensureDir: (p) => { mkdirSync(p, { recursive: true }) }, onProgress
      }),
    spawnGateway: () =>
      spawnGateway({ configPath: configPath(homeDir), workspace: echoHome(homeDir), homeDir, platform }),
    shutdown: shutdownGateway,
    readyTimeoutMs: 120_000,
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

export async function getEchoAgentVersion(): Promise<string | null> {
  const res = await nodeCommandRunner.run(venvPython(homedir(), process.platform), [
    '-c',
    'import importlib.metadata as m\ntry:\n    print(m.version("echo-agent"))\nexcept m.PackageNotFoundError:\n    raise SystemExit(1)'
  ])
  if (res.code !== 0) return null
  return res.stdout.trim() || null
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
  writeManagedConfig(buildConfigWriterDeps(), cfg)
  // stash 同源配置供桌面直连 LLM 生成会话标题(独立于 TS AgentRuntime)
  setLLMConfig({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model })
  await getEchoAgentManager().restart()
  // restart 换了端口/路径,旧 gateway 单例仍连旧 endpoint;丢弃它,
  // 下次 send 时用新 endpoint 重建 client。
  resetGatewayClient()
}

export async function restartEchoAgent(): Promise<void> {
  await getEchoAgentManager().restart()
}

export function buildWsUrl(baseUrl: string, wsPath = '/ws'): string {
  return baseUrl.replace(/^http/, 'ws') + wsPath
}

let gatewayClient: GatewayClient | null = null

export function getGatewayClient(emit: (e: Frame) => void): GatewayClient | null {
  if (gatewayClient) return gatewayClient
  const endpoint = getEchoAgentEndpoint()
  if (!endpoint) return null
  gatewayClient = new GatewayClient({
    // WS 路径来自 ready 信号(endpoint.wsPath),不再硬编码 /ws
    wsUrl: buildWsUrl(endpoint.baseUrl, endpoint.wsPath),
    createWs: (url) => new WebSocket(url) as unknown as WsLike,
    emit
  })
  return gatewayClient
}

export function resetGatewayClient(): void {
  gatewayClient?.disconnect()
  gatewayClient = null
}
