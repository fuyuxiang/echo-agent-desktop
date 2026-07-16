import { describe, it, expect } from 'vitest'
import { isReady, InstallationAbortedError, type EchoAgentStatus } from '../types'

describe('echo-agent types', () => {
  it('isReady true only for ready phase with port', () => {
    expect(isReady({ phase: 'ready', port: 51234 })).toBe(true)
  })
  it('isReady false when not ready', () => {
    const cases: EchoAgentStatus[] = [
      { phase: 'starting' },
      { phase: 'ready' }, // 缺 port
      { phase: 'error', message: 'x' }
    ]
    for (const s of cases) expect(isReady(s)).toBe(false)
  })
})

describe('InstallationAbortedError', () => {
  it('is an instance of Error', () => {
    const err = new InstallationAbortedError()
    expect(err).toBeInstanceOf(Error)
  })
  it('has correct name', () => {
    const err = new InstallationAbortedError()
    expect(err.name).toBe('InstallationAbortedError')
  })
  it('has Chinese message', () => {
    const err = new InstallationAbortedError()
    expect(err.message).toBe('安装已中止')
  })
})
