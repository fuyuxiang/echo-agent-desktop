import { parse, stringify } from 'yaml'
import { dirname } from 'node:path'
import { configPath } from './paths'

export interface ModelConfigInput {
  baseUrl: string
  apiKey: string
  model: string
}

// Desktop 内置企业组织知识库插件的受管配置。Desktop 正常启动始终传入;
// undefined 仅保留给显式移除受管配置的测试/迁移工具。
export interface OrgConfigInput {
  serverUrl: string
  credentialsPath: string
  cachePath: string
  // 关掉注入但保留工具:用于排查"答案里的材料是否来自组织库"。
  injectMode?: 'auto' | 'tool_only' | 'off'
  materialTokenBudget?: number
  // false 则强制单跳,控制 token 成本(agentic 循环是 3~10 倍)。
  allowAgentic?: boolean
}

// 桌面端作为 echo-agent 的部署宿主,负责写齐"以 gateway 模式服务于本地单用户桌面"
// 所需的全部受管配置段。这三段每次都被改写为桌面部署所需的值;其余字段(用户或
// echo-agent setup 写过的)原样保留。
//   - models:   模型与凭据(来源:服务器下发 / 设置页手填)
//   - gateway:  强制开启 + 绑 loopback + port=0(OS 分配,实际端口经 stdout 信号回报)
//               + auth.mode=open(loopback 下 echo-agent 放行,无需 token)
//   - channels: 关 cli、注册 gateway:* 流式通道(否则进程因"无活跃 channel"退出),
//               并下调流式切片阈值让短回复也逐段吐字
export function mergeManagedConfig(
  yamlText: string,
  cfg: ModelConfigInput,
  org?: OrgConfigInput
): string {
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
  applyOrgConfig(doc, org)
  return stringify(doc)
}

// 插件配置的实际读取路径是 plugins.config.<config_key>(见 echo-agent 的
// echo_agent/plugins/manager.py:141),不是 plugins.org。写错位置插件读到空
// 配置,表现为"装了但不生效"。
//
// 只改写 plugins.config.org 这一个子键:用户或其他插件在 plugins 下的配置
// (trusted_plugins、其他插件的 config)必须原样保留。
//
// token 不写在这里 —— 本函数每次都整段改写它托管的键,凭证会被覆盖;
// 凭证走 orgCredentialsPath() 的独立文件(0600)。
function applyOrgConfig(doc: Record<string, unknown>, org?: OrgConfigInput): void {
  const plugins = (doc.plugins ?? {}) as Record<string, unknown>
  const pluginConfigs = (plugins.config ?? {}) as Record<string, unknown>

  if (!org) {
    if ('org' in pluginConfigs) {
      delete pluginConfigs.org
      plugins.config = pluginConfigs
      doc.plugins = plugins
    }
    return
  }

  // 企业插件随 Desktop 默认启用。server_url 允许为空:用户尚未配置企业
  // 服务时插件会安全地不挂载 hook/tool,一旦设置地址并重启即可立即生效。
  plugins.enabled = true
  pluginConfigs.org = {
    enabled: true,
    server_url: org.serverUrl,
    credentials_path: org.credentialsPath,
    cache_path: org.cachePath,
    inject_mode: org.injectMode ?? 'auto',
    material_token_budget: org.materialTokenBudget ?? 6000,
    allow_agentic: org.allowAgentic ?? true
  }
  plugins.config = pluginConfigs
  doc.plugins = plugins
}

export function mergeManagedOrgConfig(yamlText: string, org: OrgConfigInput): string {
  const doc = (yamlText.trim() ? parse(yamlText) : {}) as Record<string, unknown>
  applyOrgConfig(doc, org)
  return stringify(doc)
}

export interface ConfigWriterDeps {
  readFile: (p: string) => string
  writeFile: (p: string, data: string) => void
  ensureDir: (p: string) => void
  homeDir: string
}

export function writeManagedConfig(
  deps: ConfigWriterDeps,
  cfg: ModelConfigInput,
  org?: OrgConfigInput
): void {
  const target = configPath(deps.homeDir)
  let existing = ''
  try {
    existing = deps.readFile(target)
  } catch (e) {
    // only treat a missing file as empty; rethrow other errors (EACCES, etc.)
    // so we never silently overwrite a config we failed to read
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e
  }
  const merged = mergeManagedConfig(existing, cfg, org)
  deps.ensureDir(dirname(target))
  deps.writeFile(target, merged)
}

/** 只更新企业插件段,不触碰已经装配好的模型/gateway/channel 配置。 */
export function writeManagedOrgConfig(deps: ConfigWriterDeps, org: OrgConfigInput): void {
  const target = configPath(deps.homeDir)
  let existing = ''
  try {
    existing = deps.readFile(target)
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e
  }
  deps.ensureDir(dirname(target))
  deps.writeFile(target, mergeManagedOrgConfig(existing, org))
}
