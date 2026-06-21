/** Agent 进程状态 */
export type AgentProcessStatus = 'stopped' | 'starting' | 'running' | 'error' | 'installing'

/** Python 环境信息 */
export interface AgentEnvInfo {
  pythonVersion: string | null
  echoAgentVersion: string | null
  venvPath: string | null
  status: 'ready' | 'not-installed' | 'broken'
}

/** Agent 进程启动结果 */
export interface AgentStartResult {
  success: boolean
  port?: number
  error?: string
}

/** 安装进度事件 */
export interface InstallProgressEvent {
  stage: 'python' | 'venv' | 'pip' | 'verify'
  progress: number
  message: string
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
