/** Agent 进程状态 */
export type AgentProcessStatus = 'stopped' | 'starting' | 'running' | 'error' | 'installing'

/** Agent 进程启动结果 */
export interface AgentStartResult {
  success: boolean
  port?: number
  error?: string
}

/** Agent 连接配置 */
export interface AgentConnectionConfig {
  mode: 'local' | 'remote'
  remoteUrl?: string
  remoteToken?: string
}

/** 模型 Provider 配置 */
export interface ModelProviderConfig {
  name: 'openai' | 'anthropic' | 'gemini' | 'bedrock' | 'openrouter'
  models?: string[]
  apiBase?: string
  /** 方案A: 直接写入 yaml 的 apiKey(来自服务器下发) */
  apiKey?: string
}

/** Agent 配置（用于生成 echo-agent.yaml） */
export interface AgentConfig {
  defaultModel: string
  providers: ModelProviderConfig[]
}

/** Agent 访问范围档位 */
export type AccessScope = 'restricted' | 'full'

/** Agent 访问范围配置(持久化于主进程 electron-store) */
export interface AgentScopeConfig {
  scope: AccessScope
  /** restricted 档锁定的工作目录;full 档忽略。未选时为空字符串 */
  workspaceDir: string
}
