export type EchoAgentPhase =
  | 'idle' | 'installing' | 'starting' | 'ready' | 'crashed' | 'updating' | 'error'

export interface EchoAgentStatus {
  phase: EchoAgentPhase
  port?: number
  message?: string
  detail?: string
}

export interface EchoAgentEndpoint {
  baseUrl: string
  // API 前缀与 WS 路径来自进程 stdout 的 ECHO_AGENT_READY 信号(echo-agent 契约),
  // 不再硬编码:默认 apiPrefix=/api/v1, wsPath=/ws,但以信号回报为准。
  apiPrefix: string
  wsPath: string
}

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export interface CommandRunner {
  run(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string>; onStdout?: (chunk: string) => void; signal?: AbortSignal }
  ): Promise<CommandResult>
}

export function isReady(status: EchoAgentStatus): boolean {
  return status.phase === 'ready' && typeof status.port === 'number'
}
