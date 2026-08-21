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

/**
 * 版本注入策略(2026-08 修订):
 *   - 默认不锁版本 → installer 走 `pip install echo-agent[all]`(latest)
 *     且启动期已装则跳过,只有 About 页面的"升级"按钮会触发 pip install -U
 *   - ECHO_AGENT_VERSION 环境变量 → 装/升到该指定版本
 *     (CI 注入固定版本测试 / 紧急回滚到旧版本)
 *   - ECHO_AGENT_ORG_VERSION 环境变量 → 插件同核心一起锁版
 *     (默认装 latest org;env 不注入但想用个人版,需在调用方传 undefined)
 */

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
    ensureInstalled: (onProgress, signal) =>
      ensureInstalled({
        runner: nodeCommandRunner, homeDir, platform, pythonArchive,
        pathExists: (p) => existsSync(p), ensureDir: (p) => { mkdirSync(p, { recursive: true }) }, onProgress,
        abortSignal: signal,
        // 默认装 latest;env 注入 ECHO_AGENT_VERSION 时锁版(CI / 紧急回滚)
        coreVersion: process.env['ECHO_AGENT_VERSION'],
        // 默认不装 org 插件;env 注入 ECHO_AGENT_ORG_VERSION 时锁版;想装 latest 则传 'latest'
        orgPluginVersion: process.env['ECHO_AGENT_ORG_VERSION']
      }),
    update: (onProgress, signal) =>
      pipUpdate({
        runner: nodeCommandRunner, homeDir, platform, pythonArchive,
        pathExists: (p) => existsSync(p), ensureDir: (p) => { mkdirSync(p, { recursive: true }) }, onProgress,
        abortSignal: signal,
        // 升级与首次安装版本策略一致(env 注入优先)
        coreVersion: process.env['ECHO_AGENT_VERSION'],
        orgPluginVersion: process.env['ECHO_AGENT_ORG_VERSION']
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

/** safeStorage 加密 key 前缀:收到 `ref:<storeKey>` 时从安全存储取真值。 */
const SECURE_REF_PREFIX = 'ref:'

/**
 * 解析入参中的 apiKey:
 * - `ref:<storeKey>` → 从 safeStorage 取真值,若取不到则抛错
 * - 其它(ollama 占位/纯字符串) → 视为业务值,直接返回
 *
 * 真实 apiKey 永不写入 yaml 中的明文字段:yaml 里只保留 `ref:` 引用或占位符。
 * 本函数在写入 yaml 前一刻完成解析,解析后的明文只在写入瞬间存在于内存。
 */
async function resolveApiKey(apiKey: string): Promise<string> {
  if (!apiKey.startsWith(SECURE_REF_PREFIX)) return apiKey
  const storeKey = apiKey.slice(SECURE_REF_PREFIX.length)
  if (!storeKey) throw new Error('无效的 apiKey 引用:缺少 storeKey')
  // 动态 import 避免循环依赖
  const { secureGet } = await import('../store')
  const real = await secureGet(storeKey)
  if (!real) throw new Error(`安全存储中无 key: ${storeKey}`)
  return real
}

export async function applyModelConfig(cfg: ModelConfigInput): Promise<void> {
  // 解析 apiKey:ref: → 从 safeStorage 取真值(写入 yaml 的瞬间即被回收,不长期驻留)
  const realApiKey = await resolveApiKey(cfg.apiKey)
  writeManagedConfig(buildConfigWriterDeps(), { ...cfg, apiKey: realApiKey })
  // stash 同源配置供桌面直连 LLM 生成会话标题(独立于 TS AgentRuntime)
  setLLMConfig({ baseUrl: cfg.baseUrl, apiKey: realApiKey, model: cfg.model })
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
