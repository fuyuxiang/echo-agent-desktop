import fs from 'fs'
import path from 'path'
import { AGENT_CONFIG_PATH } from './constants'
import { resolveWorkspace, getScopeConfig } from './scope'
import type { AgentConfig, ModelProviderConfig } from '@shared/types'

/**
 * 生成 echo-agent.yaml 配置文件
 * 桌面端控制配置生成。方案A: apiKey 直接写入 provider(来自服务器下发)。
 */
export function generateAgentConfig(config: AgentConfig): void {
  fs.mkdirSync(path.dirname(AGENT_CONFIG_PATH), { recursive: true })

  // YAML 字符串转义: 反斜杠与双引号
  const q = (v: string): string => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

  const workspace = resolveWorkspace()
  const restricted = getScopeConfig().scope === 'restricted'

  const yaml = [
    `workspace: ${q(workspace)}`,
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
    'tools:',
    `  restrict_to_workspace: ${restricted}`,
    `  profile: ${q(restricted ? 'coding' : 'full')}`,
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

  // 配置含明文 apiKey(方案A: 服务端下发后写入 yaml 供 agent 读取):
  // 以 0600 权限落盘, 仅当前用户可读写, 收紧明文密钥在磁盘上的暴露面。
  fs.writeFileSync(AGENT_CONFIG_PATH, yaml, { encoding: 'utf-8', mode: 0o600 })
  try {
    fs.chmodSync(AGENT_CONFIG_PATH, 0o600)
  } catch {
    // Windows 或部分文件系统不支持 POSIX 权限位, 忽略
  }
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

  // 与 generateAgentConfig 的 q() 反向: 去引号并反转义 \\ 与 \"
  const unq = (v: string): string => {
    const trimmed = v.trim()
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    }
    return trimmed
  }

  // 按 `    - name:` 切分各 provider 块, 保证字段与所属 provider 对应
  const providers: ModelProviderConfig[] = []
  const blocks = content.split(/^ {4}- name:/m)
  // blocks[0] 是 providers 之前的内容, 跳过
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i]
    const nameMatch = block.match(/^\s*"?([^"\n]+)"?/)
    if (!nameMatch) continue
    const provider: ModelProviderConfig = {
      name: unq(nameMatch[1]) as ModelProviderConfig['name']
    }
    const modelsMatch = block.match(/^\s*models:\s*(\[[^\n]*\])/m)
    if (modelsMatch) {
      try {
        provider.models = JSON.parse(modelsMatch[1])
      } catch {
        // 解析失败则忽略 models
      }
    }
    const apiBaseMatch = block.match(/^\s*apiBase:\s*(.+)$/m)
    if (apiBaseMatch) provider.apiBase = unq(apiBaseMatch[1])
    const apiKeyMatch = block.match(/^\s*apiKey:\s*(.+)$/m)
    if (apiKeyMatch) provider.apiKey = unq(apiKeyMatch[1])
    providers.push(provider)
  }

  return { defaultModel, providers }
}
