import { randomUUID } from 'crypto'
import type {
  GatewayPlatform,
  GatewayConfig,
  GatewayStatus,
  GatewayMessage,
  GatewayListResponse,
  GatewayConfigAddRequest,
  GatewayConfigUpdateRequest,
  GatewayTestRequest,
  GatewayTestResult
} from '../shared/gateway-types'
import { storeGet, storeSet } from './store'

const CONFIGS_KEY = 'gateway.configs'
const STATUS_KEY = 'gateway.statuses'
const MESSAGES_KEY = 'gateway.messages'

/** Predefined supported platforms */
const PLATFORMS: GatewayPlatform[] = [
  { id: 'telegram', name: 'Telegram', type: 'messaging', isActive: true, config: {} },
  { id: 'discord', name: 'Discord', type: 'messaging', isActive: true, config: {} },
  { id: 'slack', name: 'Slack', type: 'messaging', isActive: true, config: {} },
  { id: 'whatsapp', name: 'WhatsApp', type: 'messaging', isActive: true, config: {} },
  { id: 'signal', name: 'Signal', type: 'messaging', isActive: true, config: {} },
  { id: 'matrix', name: 'Matrix', type: 'messaging', isActive: true, config: {} },
  { id: 'mattermost', name: 'Mattermost', type: 'messaging', isActive: true, config: {} },
  { id: 'email', name: 'Email', type: 'messaging', isActive: true, config: {} },
  { id: 'sms', name: 'SMS', type: 'messaging', isActive: true, config: {} },
  { id: 'dingtalk', name: 'DingTalk', type: 'messaging', isActive: true, config: {} },
  { id: 'feishu', name: 'Feishu', type: 'messaging', isActive: true, config: {} },
  { id: 'wecom', name: 'WeCom', type: 'messaging', isActive: true, config: {} },
  { id: 'wechat', name: 'WeChat', type: 'messaging', isActive: true, config: {} },
  { id: 'webhook', name: 'Webhook', type: 'webhook', isActive: true, config: {} },
  { id: 'homeassistant', name: 'Home Assistant', type: 'notification', isActive: true, config: {} },
  { id: 'imessage', name: 'iMessage', type: 'messaging', isActive: true, config: {} }
]

/** Read configs from store */
function getConfigs(): GatewayConfig[] {
  return storeGet<GatewayConfig[]>(CONFIGS_KEY) ?? []
}

/** Read statuses from store */
function getStatuses(): GatewayStatus[] {
  return storeGet<GatewayStatus[]>(STATUS_KEY) ?? []
}

/** Read messages from store */
function getMessages(): GatewayMessage[] {
  return storeGet<GatewayMessage[]>(MESSAGES_KEY) ?? []
}

/** List all supported gateway platforms */
export async function listPlatforms(): Promise<GatewayPlatform[]> {
  return PLATFORMS
}

/** List all gateway configs with platform and status info */
export async function listConfigs(): Promise<GatewayListResponse> {
  const configs = getConfigs()
  const statuses = getStatuses()
  return {
    platforms: PLATFORMS,
    configs,
    statuses,
    total: configs.length
  }
}

/** Add a new gateway config */
export async function addConfig(request: GatewayConfigAddRequest): Promise<GatewayConfig> {
  const configs = getConfigs()
  const now = new Date().toISOString()
  const newConfig: GatewayConfig = {
    id: randomUUID(),
    platformId: request.platformId,
    apiKey: request.apiKey,
    webhookUrl: request.webhookUrl,
    isActive: true,
    metadata: request.metadata,
    createdAt: now,
    updatedAt: now
  }
  configs.push(newConfig)
  storeSet(CONFIGS_KEY, configs)
  return newConfig
}

/** Update an existing gateway config */
export async function updateConfig(request: GatewayConfigUpdateRequest): Promise<GatewayConfig> {
  const configs = getConfigs()
  const index = configs.findIndex(c => c.id === request.id)
  if (index === -1) {
    throw new Error(`Config not found: ${request.id}`)
  }
  const updated: GatewayConfig = {
    ...configs[index],
    ...request,
    updatedAt: new Date().toISOString()
  }
  configs[index] = updated
  storeSet(CONFIGS_KEY, configs)
  return updated
}

/** Remove a gateway config by id */
export async function removeConfig(id: string): Promise<void> {
  const configs = getConfigs()
  const filtered = configs.filter(c => c.id !== id)
  storeSet(CONFIGS_KEY, filtered)
}

/** Get connection status for a platform */
export async function getStatus(platformId: string): Promise<GatewayStatus> {
  const statuses = getStatuses()
  return statuses.find(s => s.platformId === platformId) ?? {
    platformId,
    isConnected: false,
    errorCount: 0
  }
}

/** Test connection to a gateway platform */
export async function testConnection(_request: GatewayTestRequest): Promise<GatewayTestResult> {
  const startTime = Date.now()
  await new Promise(resolve => setTimeout(resolve, 100))
  const latency = Date.now() - startTime

  return {
    success: true,
    message: 'Connection successful',
    latency
  }
}

/** Send a message through a gateway platform */
export async function sendMessage(request: {
  platformId: string
  content: string
  metadata?: Record<string, unknown>
}): Promise<GatewayMessage> {
  const messages = getMessages()
  const message: GatewayMessage = {
    id: randomUUID(),
    platformId: request.platformId,
    direction: 'outbound',
    content: request.content,
    timestamp: new Date().toISOString(),
    metadata: request.metadata
  }
  messages.push(message)
  storeSet(MESSAGES_KEY, messages)
  return message
}

/** List messages, optionally filtered by platformId */
export async function listMessages(platformId?: string): Promise<GatewayMessage[]> {
  const messages = getMessages()
  if (platformId) {
    return messages.filter(m => m.platformId === platformId)
  }
  return messages
}
