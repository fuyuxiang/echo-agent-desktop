import { parse, stringify } from 'yaml'
import { dirname } from 'node:path'
import { configPath } from './paths'

export interface ModelConfigInput {
  baseUrl: string
  apiKey: string
  model: string
}

// 桌面端作为 echo-agent 的部署宿主,负责写齐"以 gateway 模式服务于本地单用户桌面"
// 所需的全部受管配置段。这三段每次都被改写为桌面部署所需的值;其余字段(用户或
// echo-agent setup 写过的)原样保留。
//   - models:   模型与凭据(来源:服务器下发 / 设置页手填)
//   - gateway:  强制开启 + 绑 loopback + port=0(OS 分配,实际端口经 stdout 信号回报)
//               + auth.mode=open(loopback 下 echo-agent 放行,无需 token)
//   - channels: 关 cli、注册 gateway:* 流式通道(否则进程因"无活跃 channel"退出),
//               并下调流式切片阈值让短回复也逐段吐字
export function mergeManagedConfig(yamlText: string, cfg: ModelConfigInput): string {
  const doc = (yamlText.trim() ? parse(yamlText) : {}) as Record<string, unknown>
  doc.models = {
    default_model: cfg.model,
    providers: [
      { name: 'desktop', apiKey: cfg.apiKey, apiBase: cfg.baseUrl, models: [cfg.model] }
    ]
  }
  doc.gateway = {
    enabled: true,
    host: '127.0.0.1',
    port: 0,
    auth: { mode: 'open' }
  }
  doc.channels = {
    cli: { enabled: false },
    stream_channels: ['gateway:*'],
    stream_flush_chars: 24,
    stream_flush_interval_ms: 250,
    stream_paragraph_mode: false
  }
  return stringify(doc)
}

export interface ConfigWriterDeps {
  readFile: (p: string) => string
  writeFile: (p: string, data: string) => void
  ensureDir: (p: string) => void
  homeDir: string
}

export function writeManagedConfig(deps: ConfigWriterDeps, cfg: ModelConfigInput): void {
  const target = configPath(deps.homeDir)
  let existing = ''
  try {
    existing = deps.readFile(target)
  } catch (e) {
    // only treat a missing file as empty; rethrow other errors (EACCES, etc.)
    // so we never silently overwrite a config we failed to read
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e
    existing = ''
  }
  const merged = mergeManagedConfig(existing, cfg)
  deps.ensureDir(dirname(target))
  deps.writeFile(target, merged)
}
