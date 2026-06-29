import { describe, it, expect, vi } from 'vitest'
import { createStatusBus } from '../index'

describe('status bus', () => {
  it('broadcasts to subscribers and supports unsubscribe', () => {
    const bus = createStatusBus()
    const a = vi.fn()
    const off = bus.subscribe(a)
    bus.emit({ phase: 'ready', port: 1 })
    expect(a).toHaveBeenCalledWith({ phase: 'ready', port: 1 })
    off()
    bus.emit({ phase: 'idle' })
    expect(a).toHaveBeenCalledTimes(1)
  })
  it('last() returns most recent status', () => {
    const bus = createStatusBus()
    bus.emit({ phase: 'installing' })
    expect(bus.last()).toEqual({ phase: 'installing' })
  })
})
