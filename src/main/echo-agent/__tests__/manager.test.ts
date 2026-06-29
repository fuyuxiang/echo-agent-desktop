import { describe, it, expect, vi } from 'vitest'
import { EchoAgentManager, type ManagerDeps, type SpawnedProc } from '../manager'
import type { EchoAgentStatus } from '../types'

function makeProc(): SpawnedProc & { fireExit: (code: number | null) => void } {
  let cb: (code: number | null) => void = () => {}
  return {
    pid: 123,
    kill: vi.fn(),
    onExit: (fn) => { cb = fn },
    fireExit: (code) => cb(code)
  }
}

function deps(over: Partial<ManagerDeps> = {}): { d: ManagerDeps; statuses: EchoAgentStatus[]; proc: ReturnType<typeof makeProc> } {
  const statuses: EchoAgentStatus[] = []
  const proc = makeProc()
  const d: ManagerDeps = {
    ensureInstalled: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    pickPort: vi.fn(async () => 51234),
    genToken: vi.fn(() => 'tok'),
    spawnGateway: vi.fn(() => proc),
    waitHealthy: vi.fn(async () => true),
    shutdown: vi.fn(async () => {}),
    onStatus: (s) => statuses.push(s),
    maxRestarts: 2,
    ...over
  }
  return { d, statuses, proc }
}

describe('EchoAgentManager', () => {
  it('start reaches ready with port and endpoint', async () => {
    const { d } = deps()
    const m = new EchoAgentManager(d)
    await m.start()
    expect(m.getStatus().phase).toBe('ready')
    expect(m.getStatus().port).toBe(51234)
    expect(m.getEndpoint()).toEqual({ baseUrl: 'http://127.0.0.1:51234', token: 'tok' })
  })

  it('start goes error when health never passes', async () => {
    const { d } = deps({ waitHealthy: vi.fn(async () => false) })
    const m = new EchoAgentManager(d)
    await m.start()
    expect(m.getStatus().phase).toBe('error')
  })

  it('cleans up proc and prevents restart when health fails', async () => {
    const spawnGateway = vi.fn(() => makeProc())
    const { d } = deps({ waitHealthy: vi.fn(async () => false), spawnGateway })
    const m = new EchoAgentManager(d)
    await m.start()
    expect(m.getStatus().phase).toBe('error')
    const p = spawnGateway.mock.results[0].value as ReturnType<typeof makeProc>
    expect(p.kill).toHaveBeenCalled()
    // orphan exit must not relaunch
    p.fireExit(1)
    await Promise.resolve()
    await Promise.resolve()
    expect(spawnGateway).toHaveBeenCalledTimes(1)
    expect(m.getStatus().phase).toBe('error')
  })

  it('start goes error when install throws (message surfaced)', async () => {
    const { d } = deps({ ensureInstalled: vi.fn(async () => { throw new Error('no network') }) })
    const m = new EchoAgentManager(d)
    await m.start()
    expect(m.getStatus().phase).toBe('error')
    expect(m.getStatus().message).toMatch(/no network/)
  })

  it('restarts on unexpected crash up to maxRestarts then crashed', async () => {
    const spawnGateway = vi.fn(() => makeProc())
    const { d } = deps({ spawnGateway, maxRestarts: 2 })
    const m = new EchoAgentManager(d)
    await m.start()
    // simulate 3 crashes
    for (let i = 0; i < 3; i++) {
      const p = spawnGateway.mock.results[spawnGateway.mock.results.length - 1].value as ReturnType<typeof makeProc>
      p.fireExit(1)
      await Promise.resolve()
      await Promise.resolve()
    }
    expect(m.getStatus().phase).toBe('crashed')
  })

  it('stop prevents restart on exit', async () => {
    const { d, proc } = deps()
    const m = new EchoAgentManager(d)
    await m.start()
    await m.stop()
    proc.fireExit(0)
    await Promise.resolve()
    expect(d.shutdown).toHaveBeenCalled()
    expect(m.getStatus().phase).not.toBe('crashed')
  })

  it('runUpdate stops, updates, restarts', async () => {
    const { d } = deps()
    const m = new EchoAgentManager(d)
    await m.start()
    await m.runUpdate()
    expect(d.update).toHaveBeenCalled()
    expect(m.getStatus().phase).toBe('ready')
  })
})
