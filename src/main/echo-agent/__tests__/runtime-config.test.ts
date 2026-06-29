import { describe, it, expect } from 'vitest'
import { generateToken, pickFreePort } from '../runtime-config'

describe('runtime-config', () => {
  it('generateToken returns hex of expected length and is random', () => {
    const a = generateToken()
    const b = generateToken()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })
  it('pickFreePort returns a usable port number', async () => {
    const port = await pickFreePort()
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThan(65536)
  })
})
