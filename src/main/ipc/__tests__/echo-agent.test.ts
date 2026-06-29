import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) }
}))
const statusFns: Array<(s: unknown) => void> = []
vi.mock('../../echo-agent', () => ({
  getEchoAgentStatus: () => ({ phase: 'ready', port: 1 }),
  onEchoAgentStatus: (cb: (s: unknown) => void) => { statusFns.push(cb); return () => {} },
  updateEchoAgent: vi.fn(async () => {})
}))

import { registerEchoAgentIpc } from '../echo-agent'
import { IpcChannels } from '@shared/ipc-channels'
import { updateEchoAgent } from '../../echo-agent'

describe('echo-agent ipc', () => {
  beforeEach(() => handlers.clear())
  it('get-status returns current status', () => {
    registerEchoAgentIpc(() => null)
    const fn = handlers.get(IpcChannels.echoAgent.getStatus)!
    expect(fn()).toEqual({ phase: 'ready', port: 1 })
  })
  it('update delegates to updateEchoAgent', async () => {
    registerEchoAgentIpc(() => null)
    await handlers.get(IpcChannels.echoAgent.update)!()
    expect(updateEchoAgent).toHaveBeenCalled()
  })
})
