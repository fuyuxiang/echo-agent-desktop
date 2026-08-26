import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { app } from 'electron'
import log from 'electron-log/main'
import type { EchoAgentEndpoint, EchoAgentStatus } from './types'
import { EchoAgentManager } from './manager'
import { ensureInstalled, updateEchoAgent as pipUpdate } from './installer'
import {
  bundledEchoAgentCorePath,
  bundledOrgPluginPath,
  bundledPythonArchive,
  configPath,
  echoHome,
  orgCredentialsPath,
  venvPython
} from './paths'
import { nodeCommandRunner, spawnGateway, shutdownGateway } from './adapters'
import {
  writeManagedConfig,
  writeManagedOrgConfig,
  writeManagedChannels,
  type ConfigWriterDeps,
  type ModelConfigInput
} from './config-writer'
import WebSocket from 'ws'
import { GatewayClient, type Frame, type WsLike } from './gateway-client'
import { setLLMConfig } from './llm'
import { gatewayAdminToken, modelBrokerToken } from './security-tokens'
import { MODEL_BROKER_TOKEN_ENV } from './security-tokens'
import { configureModelBroker } from './model-broker'
import { buildWsUrl, createStatusBus } from './runtime-utils'
import { secureGet } from '../store'

/**
 * 安装策略:核心与企业插件都随 Desktop 分发并锁定兼容版本；启动时仅在
 * 缺失或版本不匹配时安装。About 页面的“更新”实际执行随包运行时修复，
 * 不会绕过 Desktop 的兼容性验证去追踪 PyPI 最新版。
 */

const bus = createStatusBus()
let manager: EchoAgentManager | null = null
let orgServerUrlProvider: () => string = () => ''
let agentUserId = 'desktop-user'

/** 由企业 IPC 在主进程启动时注入,避免 echo-agent 基础模块反向依赖 Store。 */
export function setOrgServerUrlProvider(provider: () => string): void {
  orgServerUrlProvider = provider
}

/**
 * 为 Agent 对话设置当前企业主体。服务器地址只用于生成不可逆命名空间，
 * 避免两套部署恰好使用相同 user id 时串权限。
 */
export function setEchoAgentUser(serverUrl: string, userId: string | null): void {
  const next = userId
    ? `org-${createHash('sha256').update(serverUrl).digest('hex').slice(0, 12)}-${userId}`
    : 'desktop-user'
  if (next === agentUserId) return
  agentUserId = next
  resetGatewayClient()
}

export function getEchoAgentUserId(): string {
  return agentUserId
}

function getManagedOrgConfig() {
  const homeDir = homedir()
  return {
    serverUrl: orgServerUrlProvider(),
    credentialsPath: orgCredentialsPath(homeDir),
    cachePath: join(app.getPath('userData'), 'echo.db'),
    injectMode: 'auto' as const,
    materialTokenBudget: 6000,
    allowAgentic: true
  }
}

export function getEchoAgentManager(): EchoAgentManager {
  if (manager) return manager
  const homeDir = homedir()
  const platform = process.platform
  const arch = process.arch
  // dev 下 process.resourcesPath 指向 Electron 自带 Resources(无我们的资源),
  // 须用项目 resources/;打包后才用 process.resourcesPath。对齐 ASR/diarization 约定。
  const resourcesRoot = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  const pythonArchive = bundledPythonArchive(resourcesRoot, platform, arch)
  const orgPluginPath = bundledOrgPluginPath(resourcesRoot)
  const corePackagePath = app.isPackaged
    ? bundledEchoAgentCorePath(resourcesRoot)
    : join(app.getAppPath(), '..', 'echo-agent')
  manager = new EchoAgentManager({
    ensureInstalled: (onProgress, signal) =>
      ensureInstalled({
        runner: nodeCommandRunner, homeDir, platform, pythonArchive, corePackagePath, orgPluginPath,
        pathExists: (p) => existsSync(p), ensureDir: (p) => { mkdirSync(p, { recursive: true }) }, onProgress,
        abortSignal: signal
      }),
    update: (onProgress, signal) =>
      pipUpdate({
        runner: nodeCommandRunner, homeDir, platform, pythonArchive, corePackagePath, orgPluginPath,
        pathExists: (p) => existsSync(p), ensureDir: (p) => { mkdirSync(p, { recursive: true }) }, onProgress,
        abortSignal: signal
      }),
    spawnGateway: () =>
      spawnGateway({
        configPath: configPath(homeDir),
        workspace: echoHome(homeDir),
        homeDir,
        platform,
        gatewayToken: gatewayAdminToken,
        modelToken: modelBrokerToken
      }),
    shutdown: (endpoint) => shutdownGateway(endpoint, gatewayAdminToken),
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
 * 本函数在配置本机模型 Broker 前完成解析；明文只存在于主进程内存中，
 * 不会传给 Agent，也不会写入 YAML。
 */
async function resolveApiKey(apiKey: string): Promise<string> {
  if (!apiKey.startsWith(SECURE_REF_PREFIX)) return apiKey
  const storeKey = apiKey.slice(SECURE_REF_PREFIX.length)
  if (!storeKey) throw new Error('无效的 apiKey 引用:缺少 storeKey')
  const real = await secureGet(storeKey)
  if (!real) throw new Error(`安全存储中无 key: ${storeKey}`)
  return real
}

export async function applyModelConfig(cfg: ModelConfigInput): Promise<void> {
  const source = cfg.source ?? 'local'
  const realApiKey =
    source === 'local'
      ? await resolveApiKey(cfg.apiKey)
      : source === 'ollama'
        ? (cfg.apiKey || 'ollama')
        : ''

  let agentBaseUrl = cfg.baseUrl
  let agentApiKey = realApiKey
  let apiKeyEnv: string | undefined
  if (source !== 'ollama') {
    const broker = await configureModelBroker(
      source === 'enterprise'
        ? { kind: 'enterprise' }
        : { kind: 'direct', baseUrl: cfg.baseUrl, apiKey: realApiKey }
    )
    agentBaseUrl = `${broker.baseUrl}/v1`
    agentApiKey = ''
    apiKeyEnv = MODEL_BROKER_TOKEN_ENV
  }
  writeManagedConfig(
    buildConfigWriterDeps(),
    {
      ...cfg,
      source,
      baseUrl: agentBaseUrl,
      apiKey: agentApiKey,
      apiKeyEnv
    },
    getManagedOrgConfig()
  )
  // Auxiliary title/meeting helpers use the same broker. Long-lived provider
  // credentials remain confined to the Electron main process.
  setLLMConfig({
    baseUrl: agentBaseUrl,
    apiKey: source === 'ollama' ? realApiKey : modelBrokerToken,
    model: cfg.model
  })
  await getEchoAgentManager().restart()
  // restart 换了端口/路径,旧 gateway 单例仍连旧 endpoint;丢弃它,
  // 下次 send 时用新 endpoint 重建 client。
  resetGatewayClient()
}

/** 启动前同步插件配置;只写文件,不会为了配置迁移额外拉起进程。 */
export function syncOrgPluginConfig(): void {
  writeManagedOrgConfig(buildConfigWriterDeps(), getManagedOrgConfig())
}

/**
 * 启动前同步 channels 段。与 syncOrgPluginConfig 一样只写文件。
 *
 * applyModelConfig 也会写这一段,但它由渲染层在模型装配后才触发,晚于进程拉起;
 * 首次安装那次对话若读到不含 channels 的 yaml,乐观流式会退化成缓冲,首屏看起来
 * 没有流式效果。这里补上,使进程无论何时启动都读到完整的桌面部署配置。
 */
export function syncManagedChannels(): void {
  writeManagedChannels(buildConfigWriterDeps())
}

/** 企业服务器切换后刷新插件配置;Agent 已运行时重启使 hook/tool 立即重载。 */
export async function applyOrgPluginConfig(): Promise<void> {
  syncOrgPluginConfig()
  if (!manager) return
  await manager.restart()
  resetGatewayClient()
}

export async function restartEchoAgent(): Promise<void> {
  await getEchoAgentManager().restart()
}

let gatewayClient: GatewayClient | null = null

export function getGatewayClient(emit: (e: Frame) => void): GatewayClient | null {
  if (gatewayClient) return gatewayClient
  const endpoint = getEchoAgentEndpoint()
  if (!endpoint) return null
  gatewayClient = new GatewayClient({
    // WS 路径来自 ready 信号(endpoint.wsPath),不再硬编码 /ws
    wsUrl: buildWsUrl(endpoint.baseUrl, endpoint.wsPath),
    token: gatewayAdminToken,
    userId: agentUserId,
    createWs: (url) => new WebSocket(url) as unknown as WsLike,
    emit
  })
  return gatewayClient
}

export function resetGatewayClient(): void {
  gatewayClient?.disconnect()
  gatewayClient = null
}
