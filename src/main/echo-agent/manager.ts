import type { EchoAgentEndpoint, EchoAgentStatus } from './types'
import { parseReadySignal } from './ready-signal'

export interface SpawnedProc {
  pid: number
  kill: (signal?: string) => void
  onExit: (cb: (code: number | null) => void) => void
  // 按行回调 stdout,供 manager 解析 ECHO_AGENT_READY 就绪信号
  onStdoutLine: (cb: (line: string) => void) => void
}

export interface ManagerDeps {
  ensureInstalled: (onProgress: (l: string) => void, signal?: AbortSignal) => Promise<void>
  update: (onProgress: (l: string) => void, signal?: AbortSignal) => Promise<void>
  spawnGateway: () => SpawnedProc
  shutdown: (endpoint: EchoAgentEndpoint) => Promise<void>
  onStatus: (s: EchoAgentStatus) => void
  // 启动后等待 ECHO_AGENT_READY 信号的超时(ms);到时未就绪 → error。
  readyTimeoutMs?: number
  // 注入式定时器(便于测试):到时调用 cb,返回取消函数。默认用 unref 的 setTimeout。
  setTimer?: (cb: () => void, ms: number) => () => void
  maxRestarts?: number
}

// 默认定时器:unref 避免阻塞 app 退出,返回取消函数。
const defaultSetTimer = (cb: () => void, ms: number): (() => void) => {
  const t = setTimeout(cb, ms)
  ;(t as unknown as { unref?: () => void }).unref?.()
  return () => clearTimeout(t)
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
  // 依赖是否已成功安装一次:install 幂等且昂贵(pip),成功后 restart/runUpdate
  // 复用,不再重复 ensureInstalled。避免"配置变更重启"与"开机启动"并发各装一遍、
  // 互相打断 pip 子进程的竞态。
  private installed = false
  // 用于取消正在进行的安装/更新子进程,doStop() 时 abort。
  private abortController: AbortController | null = null
  // 生命周期操作互斥队列:start/stop/restart/runUpdate 串行执行,杜绝并发 spawn。
  // 开机 start() 与渲染层 applyModelConfig→restart() 若并发,会各自 launch 出 gateway
  // 抢端口/在未装完时起进程,导致崩溃重启循环、Agent 永不就绪。
  private opQueue: Promise<void> = Promise.resolve()

  constructor(private deps: ManagerDeps) {}

  getStatus(): EchoAgentStatus { return this.status }
  getEndpoint(): EchoAgentEndpoint | null { return this.endpoint }

  private set(s: EchoAgentStatus): void {
    this.status = s
    this.deps.onStatus(s)
  }

  // 把一个生命周期操作排到队尾串行执行;无论成败都让队列继续,不让一次失败卡死后续。
  private enqueue(op: () => Promise<void>): Promise<void> {
    const run = this.opQueue.then(op, op)
    this.opQueue = run.catch(() => {})
    return run
  }

  // 确保依赖已安装(仅首次真正执行 ensureInstalled);幂等。
  private async ensureReady(): Promise<void> {
    if (this.installed) return
    this.abortController = new AbortController()
    this.set({ phase: 'installing' })
    try {
      await this.deps.ensureInstalled(
        (line) => this.set({ phase: 'installing', detail: line }),
        this.abortController.signal
      )
      this.installed = true
    } catch (e) {
      if (e instanceof Error && e.message === 'Installation aborted') {
        this.set({ phase: 'idle' })
        return
      }
      throw e
    }
  }

  start(): Promise<void> {
    return this.enqueue(async () => {
      try {
        // fresh user-initiated start resets the crash-restart budget and stop flag
        this.restarts = 0
        this.stopped = false
        await this.ensureReady()
        await this.launch()
      } catch (e) {
        this.set({ phase: 'error', message: e instanceof Error ? e.message : String(e) })
      }
    })
  }

  private async launch(): Promise<void> {
    // 退出/停止已请求(可能在 in-flight ensureInstalled 期间发生):不再拉起 gateway,
    // 避免 stop() 之后 install resolve 又把进程重新 spawn 的竞态。
    if (this.stopped) {
      this.set({ phase: 'idle' })
      return
    }
    this.stopping = false
    this.set({ phase: 'starting' })
    const proc = this.deps.spawnGateway()
    this.proc = proc
    proc.onExit((code) => this.onExit(code))

    // 等待 ECHO_AGENT_READY 信号:命中则据信号派生 endpoint → ready;
    // 超时未见信号 → kill + error(且不触发崩溃重启)。
    await new Promise<void>((resolve) => {
      let settled = false
      const timeoutMs = this.deps.readyTimeoutMs ?? 120_000
      const cancelTimer = (this.deps.setTimer ?? defaultSetTimer)(() => {
        if (settled) return
        settled = true
        proc.kill()
        this.proc = null
        this.stopping = true
        this.set({ phase: 'error', message: 'gateway 启动超时:未收到 ready 信号' })
        resolve()
      }, timeoutMs)

      proc.onStdoutLine((line) => {
        if (settled) return
        const sig = parseReadySignal(line)
        if (!sig) return
        settled = true
        cancelTimer()
        this.endpoint = {
          baseUrl: `http://127.0.0.1:${sig.port}`,
          apiPrefix: sig.apiPrefix,
          wsPath: sig.wsPath
        }
        this.set({ phase: 'ready', port: sig.port })
        resolve()
      })
    })
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

  stop(): Promise<void> {
    // stop 不入队:它必须能随时打断正在排队/进行的 start/restart(含安装期)。
    // 置 stopped 标志后,入队中的操作在 launch 前看到 stopped 即放弃 spawn。
    return this.doStop()
  }

  // 实际停止逻辑(不排队):供公开 stop() 及 restart/runUpdate 内部复用,避免自排队死锁。
  private async doStop(): Promise<void> {
    this.stopping = true
    this.stopped = true
    // 取消正在进行的安装/更新子进程。
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
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
    this.endpoint = null
    this.set({ phase: 'idle' })
  }

  runUpdate(): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.doStop()
        // doStop() 置 stopped=true;本次更新是用户主动重启,需复位允许 launch() spawn。
        this.stopped = false
        this.abortController = new AbortController()
        this.set({ phase: 'updating' })
        await this.deps.update(
          (line) => this.set({ phase: 'updating', detail: line }),
          this.abortController.signal
        )
        await this.launch()
      } catch (e) {
        if (e instanceof Error && e.message === 'Installation aborted') {
          this.set({ phase: 'idle' })
          return
        }
        this.set({ phase: 'error', message: e instanceof Error ? e.message : String(e) })
      }
    })
  }

  restart(): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.doStop()
        // doStop() 置 stopped=true;本次为配置变更触发的主动重启,需复位允许 launch() spawn。
        this.stopped = false
        // 配置变更可能早于开机安装完成:restart 也须确保依赖装好再起,
        // 否则会在 echo_agent 未装上时 spawn gateway → 崩溃重启循环 → Agent 永不就绪。
        this.restarts = 0
        await this.ensureReady()
        await this.launch()
      } catch (e) {
        this.set({ phase: 'error', message: e instanceof Error ? e.message : String(e) })
      }
    })
  }
}
