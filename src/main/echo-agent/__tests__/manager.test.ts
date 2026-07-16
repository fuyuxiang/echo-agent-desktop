import { describe, it, expect, vi } from 'vitest'
import { EchoAgentManager, type ManagerDeps, type SpawnedProc } from '../manager'
import type { EchoAgentStatus } from '../types'
import { InstallationAbortedError } from '../types'

const READY = 'ECHO_AGENT_READY port=51234 ws=/ws health=/api/v1/health'

function makeProc(): SpawnedProc & {
  fireExit: (code: number | null) => void
  fireStdout: (line: string) => void
} {
  let exitCb: (code: number | null) => void = () => {}
  let lineCb: (line: string) => void = () => {}
  return {
    pid: 123,
    kill: vi.fn(),
    onExit: (fn) => { exitCb = fn },
    onStdoutLine: (fn) => { lineCb = fn },
    fireExit: (code) => exitCb(code),
    fireStdout: (line) => lineCb(line)
  }
}

// 让 spawn 出的进程在被 spawn 后的微任务里自动发 ready 信号,模拟正常启动。
function autoReady(proc: ReturnType<typeof makeProc>): void {
  queueMicrotask(() => proc.fireStdout(READY))
}

function deps(over: Partial<ManagerDeps> = {}): {
  d: ManagerDeps; statuses: EchoAgentStatus[]; proc: ReturnType<typeof makeProc>
} {
  const statuses: EchoAgentStatus[] = []
  const proc = makeProc()
  const d: ManagerDeps = {
    ensureInstalled: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    spawnGateway: vi.fn(() => { autoReady(proc); return proc }),
    shutdown: vi.fn(async () => {}),
    onStatus: (s) => statuses.push(s),
    readyTimeoutMs: 1000,
    setTimer: () => () => {}, // 默认不真正计时(测试手动控制),返回 cancel
    maxRestarts: 2,
    ...over
  }
  return { d, statuses, proc }
}

describe('EchoAgentManager', () => {
  it('start 收到 ready 信号后到达 ready,并据信号派生 endpoint', async () => {
    const { d } = deps()
    const m = new EchoAgentManager(d)
    await m.start()
    expect(m.getStatus().phase).toBe('ready')
    expect(m.getStatus().port).toBe(51234)
    expect(m.getEndpoint()).toEqual({
      baseUrl: 'http://127.0.0.1:51234',
      apiPrefix: '/api/v1',
      wsPath: '/ws'
    })
  })

  it('超时未收到 ready 信号则 error 并 kill 进程', async () => {
    // spawn 出的进程永不发 ready;setTimer 立即触发超时回调
    const proc = makeProc()
    const { d } = deps({
      spawnGateway: vi.fn(() => proc), // 不 autoReady
      setTimer: (cb) => { cb(); return () => {} }
    })
    const m = new EchoAgentManager(d)
    await m.start()
    expect(m.getStatus().phase).toBe('error')
    expect(proc.kill).toHaveBeenCalled()
  })

  it('超时 error 后孤儿退出不再拉起', async () => {
    const proc = makeProc()
    const spawnGateway = vi.fn(() => proc)
    const { d } = deps({ spawnGateway, setTimer: (cb) => { cb(); return () => {} } })
    const m = new EchoAgentManager(d)
    await m.start()
    expect(m.getStatus().phase).toBe('error')
    proc.fireExit(1)
    await Promise.resolve(); await Promise.resolve()
    expect(spawnGateway).toHaveBeenCalledTimes(1)
    expect(m.getStatus().phase).toBe('error')
  })

  it('安装抛错则 error 且透出消息', async () => {
    const { d } = deps({ ensureInstalled: vi.fn(async () => { throw new Error('no network') }) })
    const m = new EchoAgentManager(d)
    await expect(m.start()).rejects.toThrow('no network')
    expect(m.getStatus().phase).toBe('error')
    expect(m.getStatus().message).toMatch(/no network/)
  })

  it('异常崩溃重启到 maxRestarts 后 crashed', async () => {
    const spawnGateway = vi.fn(() => { const p = makeProc(); autoReady(p); return p })
    const { d } = deps({ spawnGateway, maxRestarts: 2 })
    const m = new EchoAgentManager(d)
    await m.start()
    for (let i = 0; i < 3; i++) {
      const p = spawnGateway.mock.results[spawnGateway.mock.results.length - 1].value as ReturnType<typeof makeProc>
      p.fireExit(1)
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    }
    expect(m.getStatus().phase).toBe('crashed')
  })

  it('stop 阻止退出后重启', async () => {
    const { d, proc } = deps()
    const m = new EchoAgentManager(d)
    await m.start()
    await m.stop()
    proc.fireExit(0)
    await Promise.resolve()
    expect(d.shutdown).toHaveBeenCalled()
    expect(m.getStatus().phase).not.toBe('crashed')
  })

  it('stop 发 SIGTERM', async () => {
    const { d, proc } = deps()
    const m = new EchoAgentManager(d)
    await m.start()
    await m.stop()
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('安装期 stop 阻止 install resolve 后再 spawn', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((res) => { release = res })
    const spawnGateway = vi.fn(() => { const p = makeProc(); autoReady(p); return p })
    const { d } = deps({
      ensureInstalled: vi.fn(async () => { await gate }),
      spawnGateway
    })
    const m = new EchoAgentManager(d)
    const starting = m.start()
    await Promise.resolve()
    expect(m.getStatus().phase).toBe('installing')
    await m.stop()
    release()
    await starting
    await Promise.resolve()
    expect(spawnGateway).not.toHaveBeenCalled()
    expect(m.getStatus().phase).toBe('idle')
  })

  it('runUpdate 停止-更新-重启回到 ready', async () => {
    const { d } = deps()
    const m = new EchoAgentManager(d)
    await m.start()
    await m.runUpdate()
    expect(d.update).toHaveBeenCalled()
    expect(m.getStatus().phase).toBe('ready')
  })
})

describe('EchoAgentManager.restart', () => {
  it('停止后重启回到 ready', async () => {
    const { d } = deps()
    const m = new EchoAgentManager(d)
    await m.start()
    await m.restart()
    expect(d.shutdown).toHaveBeenCalled()
    expect(m.getStatus().phase).toBe('ready')
  })

  it('重启后据新 ready 信号刷新 endpoint', async () => {
    const ports = [51111, 52222]
    let i = 0
    const spawnGateway = vi.fn(() => {
      const p = makeProc()
      const port = ports[i++]
      queueMicrotask(() => p.fireStdout(`ECHO_AGENT_READY port=${port} ws=/ws health=/api/v1/health`))
      return p
    })
    const { d } = deps({ spawnGateway })
    const m = new EchoAgentManager(d)
    await m.start()
    await m.restart()
    expect(m.getEndpoint()?.baseUrl).toBe('http://127.0.0.1:52222')
  })

  it('并发 start 与 restart:install 只执行一次,串行化后到达 ready', async () => {
    // 复刻真实竞态:开机 start() 与渲染层 applyModelConfig→restart() 几乎同时触发。
    // install 慢(gate 控制),期间 restart 入队。修复前两路并发各自 launch、在未装完时
    // spawn gateway → 崩溃循环;修复后串行化 + installed 门,install 仅一次,最终 ready。
    let release: () => void = () => {}
    const gate = new Promise<void>((res) => { release = res })
    const ensureInstalled = vi.fn(async () => { await gate })
    const spawnGateway = vi.fn(() => { const p = makeProc(); autoReady(p); return p })
    const { d } = deps({ ensureInstalled, spawnGateway })
    const m = new EchoAgentManager(d)
    const p1 = m.start()
    const p2 = m.restart()
    await Promise.resolve()
    // install 尚未完成前,绝不应 spawn gateway
    expect(spawnGateway).not.toHaveBeenCalled()
    release()
    await Promise.all([p1, p2])
    expect(ensureInstalled).toHaveBeenCalledTimes(1)
    expect(m.getStatus().phase).toBe('ready')
  })
})

describe('EchoAgentManager abort behavior', () => {
  it('doStop() aborts in-flight installation and transitions to idle', async () => {
    let resolveInstall: () => void = () => {}
    let capturedSignal: AbortSignal | undefined
    const ensureInstalled = vi.fn(async (_onProgress: (l: string) => void, signal?: AbortSignal) => {
      capturedSignal = signal
      await new Promise<void>((res) => { resolveInstall = res })
    })
    const spawnGateway = vi.fn(() => { const p = makeProc(); autoReady(p); return p })
    const { d } = deps({ ensureInstalled, spawnGateway })
    const m = new EchoAgentManager(d)
    // Start will be stuck in ensureInstalled
    const startPromise = m.start()
    await Promise.resolve()
    expect(m.getStatus().phase).toBe('installing')
    // Stop while installation is in-flight
    await m.stop()
    // The signal should have been aborted
    expect(capturedSignal).toBeDefined()
    expect(capturedSignal!.aborted).toBe(true)
    // Should not have spawned gateway
    expect(spawnGateway).not.toHaveBeenCalled()
    expect(m.getStatus().phase).toBe('idle')
    // Let the stuck install resolve (simulating the abort path in real code)
    // In the real code, ensureInstalled would throw InstallationAbortedError
    // after signal.abort() is called. Here we resolve manually to complete the test.
    resolveInstall()
    await startPromise.catch(() => {}) // swallow the error from the stale start
  })

  it('abort signal is passed to ensureInstalled', async () => {
    let capturedSignal: AbortSignal | undefined
    const ensureInstalled = vi.fn(async (_onProgress: (l: string) => void, signal?: AbortSignal) => {
      capturedSignal = signal
    })
    const spawnGateway = vi.fn(() => { const p = makeProc(); autoReady(p); return p })
    const { d } = deps({ ensureInstalled, spawnGateway })
    const m = new EchoAgentManager(d)
    await m.start()
    // After successful start, signal was passed but not aborted
    expect(capturedSignal).toBeDefined()
    expect(capturedSignal!.aborted).toBe(false)
    expect(m.getStatus().phase).toBe('ready')
  })

  it('doStop during installation aborts signal, InstallationAbortedError results in idle', async () => {
    // Simulate the real flow: ensureInstalled reacts to abort by rejecting with InstallationAbortedError
    let rejectInstall: (err: Error) => void = () => {}
    const ensureInstalled = vi.fn(async (_onProgress: (l: string) => void, _signal?: AbortSignal) => {
      await new Promise<void>((_resolve, reject) => {
        rejectInstall = reject
      })
    })
    const spawnGateway = vi.fn(() => { const p = makeProc(); autoReady(p); return p })
    const { d } = deps({ ensureInstalled, spawnGateway })
    const m = new EchoAgentManager(d)
    const startPromise = m.start()
    await Promise.resolve()
    expect(m.getStatus().phase).toBe('installing')
    // Abort the installation — simulate what the real installer does after signal.abort()
    rejectInstall(new InstallationAbortedError())
    // Now stop — abortController.abort() runs, but ensureInstalled already rejected
    await m.stop()
    // The start() promise should resolve (not reject) because ensureReady catches InstallationAbortedError
    await startPromise
    expect(m.getStatus().phase).toBe('idle')
    expect(spawnGateway).not.toHaveBeenCalled()
  })
})
