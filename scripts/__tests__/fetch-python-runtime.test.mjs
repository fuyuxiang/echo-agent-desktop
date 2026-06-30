import { describe, it, expect } from 'vitest'
import { resolveTargets, resolveAllTargets, platformKey, matchAsset } from '../fetch-python-runtime.mjs'

describe('platformKey', () => {
  it('maps platform/arch to key', () => {
    expect(platformKey('darwin', 'arm64')).toBe('mac-arm64')
    expect(platformKey('darwin', 'x64')).toBe('mac-x64')
    expect(platformKey('win32', 'x64')).toBe('win-x64')
  })
  it('throws on unsupported platform', () => {
    expect(() => platformKey('linux', 'x64')).toThrow()
  })
})

describe('resolveTargets', () => {
  it('returns single target matching current platform/arch with tar.gz dest', () => {
    const t = resolveTargets('darwin', 'arm64', 'http://src')
    expect(t).toHaveLength(1)
    expect(t[0].key).toBe('mac-arm64')
    expect(t[0].triple).toBe('aarch64-apple-darwin')
    expect(t[0].url).toBe('http://src/mac-arm64.tar.gz')
    expect(t[0].dest).toMatch(/resources[\\/]python-standalone-mac-arm64\.tar\.gz$/)
  })
  it('url is null when no base url (resolved later from GitHub release)', () => {
    expect(resolveTargets('darwin', 'arm64', null)[0].url).toBeNull()
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

describe('matchAsset', () => {
  const assets = [
    { name: 'cpython-3.12.7+20241016-aarch64-apple-darwin-install_only.tar.gz' },
    { name: 'cpython-3.12.7+20241016-x86_64-pc-windows-msvc-install_only.tar.gz' },
    { name: 'cpython-3.12.7+20241016-aarch64-apple-darwin-debug-full.tar.zst' }
  ]
  it('matches install_only asset for triple', () => {
    expect(matchAsset(assets, 'aarch64-apple-darwin')?.name)
      .toBe('cpython-3.12.7+20241016-aarch64-apple-darwin-install_only.tar.gz')
    expect(matchAsset(assets, 'x86_64-pc-windows-msvc')?.name)
      .toBe('cpython-3.12.7+20241016-x86_64-pc-windows-msvc-install_only.tar.gz')
  })
  it('returns undefined when no install_only match', () => {
    expect(matchAsset(assets, 'x86_64-apple-darwin')).toBeUndefined()
  })
})
