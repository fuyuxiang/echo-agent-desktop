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
  token: string
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
    opts?: { cwd?: string; env?: Record<string, string>; onStdout?: (chunk: string) => void }
  ): Promise<CommandResult>
}

export function isReady(status: EchoAgentStatus): boolean {
  return status.phase === 'ready' && typeof status.port === 'number'
}
