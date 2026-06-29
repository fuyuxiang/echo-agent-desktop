import { describe, it, expect } from 'vitest'
import { resolveTargets, resolveAllTargets } from '../fetch-python-runtime.mjs'

describe('resolveTargets', () => {
  it('returns single target matching current platform/arch', () => {
    const t = resolveTargets('darwin', 'arm64', 'http://src')
    expect(t).toHaveLength(1)
    expect(t[0].key).toBe('mac-arm64')
    expect(t[0].url).toBe('http://src/mac-arm64.tar.gz')
    expect(t[0].dest).toMatch(/resources[\\/]echo-runtime[\\/]python[\\/]mac-arm64$/)
  })
  it('maps windows', () => {
    expect(resolveTargets('win32', 'x64', 'http://s')[0].key).toBe('win-x64')
  })
  it('throws on unsupported platform', () => {
    expect(() => resolveTargets('linux', 'x64', 'http://s')).toThrow()
  })
})

describe('resolveAllTargets', () => {
  it('mac returns both arm64 and x64 targets', () => {
    const t = resolveAllTargets('darwin', 'http://src')
    expect(t).toHaveLength(2)
    expect(t.map((x) => x.key)).toEqual(['mac-arm64', 'mac-x64'])
    expect(t.find((x) => x.key === 'mac-arm64').url).toBe('http://src/mac-arm64.tar.gz')
    expect(t.find((x) => x.key === 'mac-x64').url).toBe('http://src/mac-x64.tar.gz')
  })
  it('win returns single x64 target', () => {
    const t = resolveAllTargets('win32', 'http://s')
    expect(t).toHaveLength(1)
    expect(t[0].key).toBe('win-x64')
  })
  it('throws on unsupported platform', () => {
    expect(() => resolveAllTargets('linux', 'http://s')).toThrow()
  })
})
