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
  // 一旦 stop() 被调用即置 true:用于堵住安装期退出竞态——
  // in-flight 的 start() 在 ensureInstalled resolve 后不得再 spawn gateway。
  private stopped = false
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
      // fresh user-initiated start resets the crash-restart budget and stop flag
      this.restarts = 0
      this.stopped = false
      this.set({ phase: 'installing' })
      // TODO: installer 的 pip 子进程当前未被跟踪/取消;安装期 stop() 只能堵住
      // "退出后又拉起 gateway" 的竞态,在途的 pip 进程会继续跑到自然结束。
      await this.deps.ensureInstalled((line) => this.set({ phase: 'installing', detail: line }))
      await this.launch()
    } catch (e) {
      this.set({ phase: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  private async launch(): Promise<void> {
    // 退出/停止已请求(可能在 in-flight ensureInstalled 期间发生):不再拉起 gateway,
    // 避免 stop() 之后 install resolve 又把进程重新 spawn 的竞态。
    if (this.stopped) {
      this.set({ phase: 'idle' })
      return
    }
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
      // health failed: clean up the spawned proc so it neither leaks
      // nor triggers a crash-restart when it later exits on its own
      this.proc?.kill()
      this.proc = null
      this.stopping = true
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
    this.stopped = true
    if (this.endpoint) {
      try { await this.deps.shutdown(this.endpoint) } catch { /* fall through to kill */ }
    }
    const proc = this.proc
    if (proc) {
      proc.kill('SIGTERM')
      // 兜底:若进程忽略 SIGTERM 不退出,短延时后升级 SIGKILL 防止留孤儿。
      // timer unref,绝不阻塞 app 退出。
      const t = setTimeout(() => { proc.kill('SIGKILL') }, 3000)
      ;(t as unknown as { unref?: () => void }).unref?.()
    }
    this.proc = null
    this.set({ phase: 'idle' })
  }

  async runUpdate(): Promise<void> {
    try {
      await this.stop()
      // stop() 置 stopped=true;本次更新是用户主动重启,需复位允许 launch() spawn。
      this.stopped = false
      this.set({ phase: 'updating' })
      await this.deps.update((line) => this.set({ phase: 'updating', detail: line }))
      await this.launch()
    } catch (e) {
      this.set({ phase: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }
}
