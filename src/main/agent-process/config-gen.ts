import fs from 'fs'
import path from 'path'
import { AGENT_CONFIG_PATH, AGENT_WORKSPACE } from './constants'
import type { AgentConfig, ModelProviderConfig } from '@shared/types'

/**
 * 生成 echo-agent.yaml 配置文件
 * 桌面端控制配置生成。方案A: apiKey 直接写入 provider(来自服务器下发)。
 */
export function generateAgentConfig(config: AgentConfig): void {
  fs.mkdirSync(path.dirname(AGENT_CONFIG_PATH), { recursive: true })

  // YAML 字符串转义: 反斜杠与双引号
  const q = (v: string): string => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

  const yaml = [
    `workspace: ${q(AGENT_WORKSPACE)}`,
    '',
    'models:',
    `  defaultModel: ${q(config.defaultModel)}`,
    '  providers:',
    ...config.providers.map((p) => {
      const lines = [`    - name: ${q(p.name)}`]
      if (p.models?.length) lines.push(`      models: ${JSON.stringify(p.models)}`)
      if (p.apiBase) lines.push(`      apiBase: ${q(p.apiBase)}`)
      if (p.apiKey) lines.push(`      apiKey: ${q(p.apiKey)}`)
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
    // 桌面端 auth 上报 platform=desktop, 后端 channel 实际为 gateway:desktop;
    // 用 gateway:* 通配命中所有网关连接, 避免写死具体 platform 导致流式开关失配
    '    - "gateway:*"',
    // 桌面端默认开启细粒度流式: 降低切片阈值并关闭段落聚合,
    // 让短回复也能逐段吐字(默认 180字/1.5秒/段落模式 对桌面端体验太迟钝)
    '  stream_flush_chars: 24',
    '  stream_flush_interval_ms: 250',
    '  stream_paragraph_mode: false',
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
