import fs from 'fs'
import path from 'path'
import { AGENT_CONFIG_PATH, AGENT_WORKSPACE } from './constants'
import type { AgentConfig, ModelProviderConfig } from '@shared/types'

/**
 * 生成 echo-agent.yaml 配置文件
 * 桌面端控制配置生成，API Key 不写入文件（通过 env 注入）
 */
export function generateAgentConfig(config: AgentConfig): void {
  fs.mkdirSync(path.dirname(AGENT_CONFIG_PATH), { recursive: true })

  const providers = config.providers.map((p) => {
    const entry: Record<string, unknown> = { name: p.name }
    if (p.models?.length) entry.models = p.models
    if (p.apiBase) entry.apiBase = p.apiBase
    return entry
  })

  const yaml = [
    `workspace: "${AGENT_WORKSPACE}"`,
    '',
    'models:',
    `  defaultModel: "${config.defaultModel}"`,
    '  providers:',
    ...providers.map((p) => {
      const lines = [`    - name: "${p.name}"`]
      if (p.models) lines.push(`      models: ${JSON.stringify(p.models)}`)
      if (p.apiBase) lines.push(`      apiBase: "${p.apiBase}"`)
      return lines.join('\n')
    }),
    '',
    'gateway:',
    '  enabled: true',
    '  host: "127.0.0.1"',
    '  port: 0',
    '  auth:',
    '    mode: open',
    '',
    'channels:',
    '  cli:',
    '    enabled: false',
    '  stream_channels:',
    '    - "gateway:ws"',
    ''
  ].join('\n')

  fs.writeFileSync(AGENT_CONFIG_PATH, yaml, 'utf-8')
}

/** 检查配置文件是否存在 */
export function hasAgentConfig(): boolean {
  return fs.existsSync(AGENT_CONFIG_PATH)
}

/** 读取当前配置（简单 YAML 解析，只取我们关心的字段） */
export function readAgentConfig(): AgentConfig | null {
  if (!fs.existsSync(AGENT_CONFIG_PATH)) return null
  const content = fs.readFileSync(AGENT_CONFIG_PATH, 'utf-8')
  const modelMatch = content.match(/defaultModel:\s*"?([^"\n]+)"?/)
  const defaultModel = modelMatch?.[1] ?? ''
  const providerMatches = [...content.matchAll(/- name:\s*"?(\w+)"?/g)]
  const providers = providerMatches.map((m) => ({ name: m[1] as ModelProviderConfig['name'] }))
  return { defaultModel, providers }
}
