import { describe, it, expect, vi } from 'vitest'
import { parse } from 'yaml'
import { mergeManagedConfig, writeManagedConfig, type ConfigWriterDeps } from '../config-writer'

// index.ts pulls in electron-log/main transitively; stub it so buildConfigWriterDeps
// can be imported without an Electron runtime.
vi.mock('electron-log/main', () => ({ default: { info() {}, warn() {}, error() {} } }))

import { buildConfigWriterDeps } from '../index'

const cfg = { baseUrl: 'https://api.x.com/v1', apiKey: 'sk-abc', model: 'gpt-4o' }

describe('mergeManagedConfig', () => {
  it('writes models block on empty yaml', () => {
    const out = parse(mergeManagedConfig('', cfg))
    expect(out.models.default_model).toBe('gpt-4o')
    expect(out.models.providers).toEqual([
      { name: 'desktop', apiKey: 'sk-abc', apiBase: 'https://api.x.com/v1', models: ['gpt-4o'] }
    ])
  })

  it('writes gateway block for loopback + open auth (port 0 = OS assigned)', () => {
    const out = parse(mergeManagedConfig('', cfg))
    expect(out.gateway.enabled).toBe(true)
    expect(out.gateway.host).toBe('127.0.0.1')
    expect(out.gateway.port).toBe(0)
    expect(out.gateway.auth.mode).toBe('open')
  })

  it('writes channels block so gateway mode has stream output and no cli', () => {
    const out = parse(mergeManagedConfig('', cfg))
    expect(out.channels.cli.enabled).toBe(false)
    expect(out.channels.stream_channels).toEqual(['gateway:*'])
    expect(out.channels.stream_paragraph_mode).toBe(false)
  })

  it('preserves non-managed top-level keys, overwrites managed ones', () => {
    const existing = 'memory:\n  enabled: true\ngateway:\n  port: 9999\n'
    const out = parse(mergeManagedConfig(existing, cfg))
    // 非受管段原样保留
    expect(out.memory).toEqual({ enabled: true })
    // 受管段(gateway)被改写为桌面部署所需值,旧 port 9999 被覆盖
    expect(out.gateway.enabled).toBe(true)
    expect(out.gateway.port).toBe(0)
    expect(out.models.default_model).toBe('gpt-4o')
  })

  it('overwrites a pre-existing models block', () => {
    const existing = 'models:\n  default_model: old\n  providers:\n    - name: old\nfoo: bar\n'
    const out = parse(mergeManagedConfig(existing, cfg))
    expect(out.models.default_model).toBe('gpt-4o')
    expect(out.models.providers).toHaveLength(1)
    expect(out.models.providers[0].name).toBe('desktop')
    expect(out.foo).toBe('bar')
  })
})

describe('writeManagedConfig', () => {
  function fakeDeps(initial: Record<string, string> = {}): {
    deps: ConfigWriterDeps; files: Record<string, string>; dirs: string[]
  } {
    const files: Record<string, string> = { ...initial }
    const dirs: string[] = []
    const deps: ConfigWriterDeps = {
      homeDir: '/home/u',
      readFile: (p) => {
        if (p in files) return files[p]
        const err: NodeJS.ErrnoException = new Error('ENOENT')
        err.code = 'ENOENT'
        throw err
      },
      writeFile: (p, data) => { files[p] = data },
      ensureDir: (p) => { dirs.push(p) }
    }
    return { deps, files, dirs }
  }

  it('writes merged yaml to configPath, treating missing file as empty', () => {
    const { deps, files } = fakeDeps()
    writeManagedConfig(deps, { baseUrl: 'u', apiKey: 'k', model: 'm' })
    const written = files['/home/u/.echo-agent/echo-agent.yaml']
    expect(written).toBeTruthy()
    const out = parse(written)
    expect(out.models.default_model).toBe('m')
    expect(out.gateway.enabled).toBe(true)
  })

  it('ensures the config directory exists before writing', () => {
    const { deps, dirs } = fakeDeps()
    writeManagedConfig(deps, { baseUrl: 'u', apiKey: 'k', model: 'm' })
    expect(dirs).toContain('/home/u/.echo-agent')
  })

  it('preserves existing non-managed config keys', () => {
    const { deps, files } = fakeDeps({
      '/home/u/.echo-agent/echo-agent.yaml': 'memory:\n  enabled: true\n'
    })
    writeManagedConfig(deps, { baseUrl: 'u', apiKey: 'k', model: 'm' })
    const out = parse(files['/home/u/.echo-agent/echo-agent.yaml'])
    expect(out.memory).toEqual({ enabled: true })
    expect(out.models.default_model).toBe('m')
  })

  it('rethrows non-ENOENT read errors without overwriting', () => {
    const target = '/home/u/.echo-agent/echo-agent.yaml'
    const files: Record<string, string> = { [target]: 'memory:\n  enabled: true\n' }
    let wrote = false
    const deps: ConfigWriterDeps = {
      homeDir: '/home/u',
      readFile: () => {
        const err: NodeJS.ErrnoException = new Error('EACCES')
        err.code = 'EACCES'
        throw err
      },
      writeFile: (p, data) => { files[p] = data; wrote = true },
      ensureDir: () => {}
    }
    expect(() => writeManagedConfig(deps, { baseUrl: 'u', apiKey: 'k', model: 'm' })).toThrow()
    expect(wrote).toBe(false)
  })
})

describe('buildConfigWriterDeps', () => {
  it('provides homeDir and fs-backed io', () => {
    const d = buildConfigWriterDeps()
    expect(typeof d.homeDir).toBe('string')
    expect(d.homeDir.length).toBeGreaterThan(0)
    expect(typeof d.readFile).toBe('function')
    expect(typeof d.writeFile).toBe('function')
    expect(typeof d.ensureDir).toBe('function')
  })
})
