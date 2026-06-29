import type { EchoAgentEndpoint, EchoAgentStatus } from './types'

export interface SpawnedProc {
  pid: number
  kill: (signal?: string) => void
  onExit: (cb: (code: number | null) => void) => void
}

export interface ManagerDeps {
  ensureInstalled: (onProgress: (l: string) => void) => Promise<void>
  update: (onProgress: (l: string) => void) => Promise<void>
  pickPort: () => Promise<number>
  genToken: () => string
  spawnGateway: (args: { port: number; token: string }) => SpawnedProc
  waitHealthy: (baseUrl: string) => Promise<boolean>
  shutdown: (endpoint: EchoAgentEndpoint) => Promise<void>
  onStatus: (s: EchoAgentStatus) => void
  maxRestarts?: number
}

export class EchoAgentManager {
  private status: EchoAgentStatus = { phase: 'idle' }
  private endpoint: EchoAgentEndpoint | null = null
  private proc: SpawnedProc | null = null
  private stopping = false
  private restarts = 0

  constructor(private deps: ManagerDeps) {}

  getStatus(): EchoAgentStatus { return this.status }
  getEndpoint(): EchoAgentEndpoint | null { return this.endpoint }

  private set(s: EchoAgentStatus): void {
    this.status = s
    this.deps.onStatus(s)
  }

  async start(): Promise<void> {
    try {
      // fresh user-initiated start resets the crash-restart budget
      this.restarts = 0
      this.set({ phase: 'installing' })
      await this.deps.ensureInstalled((line) => this.set({ phase: 'installing', detail: line }))
      await this.launch()
    } catch (e) {
      this.set({ phase: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  private async launch(): Promise<void> {
    const port = await this.deps.pickPort()
    const token = this.deps.genToken()
    const baseUrl = `http://127.0.0.1:${port}`
    this.endpoint = { baseUrl, token }
    this.stopping = false
    this.set({ phase: 'starting', port })
    this.proc = this.deps.spawnGateway({ port, token })
    this.proc.onExit((code) => this.onExit(code))
    const ok = await this.deps.waitHealthy(baseUrl)
    if (ok) {
      this.set({ phase: 'ready', port })
    } else {
      this.set({ phase: 'error', port, message: 'gateway 健康检查超时' })
    }
  }

  private onExit(code: number | null): void {
    if (this.stopping) return
    const max = this.deps.maxRestarts ?? 3
    if (this.restarts >= max) {
      this.set({ phase: 'crashed', message: `进程多次异常退出 (code=${code})` })
      return
    }
    this.restarts++
    void this.launch()
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.endpoint) {
      try { await this.deps.shutdown(this.endpoint) } catch { /* fall through to kill */ }
    }
    this.proc?.kill()
    this.proc = null
    this.set({ phase: 'idle' })
  }

  async runUpdate(): Promise<void> {
    try {
      await this.stop()
      this.set({ phase: 'updating' })
      await this.deps.update((line) => this.set({ phase: 'updating', detail: line }))
      await this.launch()
    } catch (e) {
      this.set({ phase: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }
}
