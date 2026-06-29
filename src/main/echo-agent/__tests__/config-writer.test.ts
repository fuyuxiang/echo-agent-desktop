import { describe, it, expect, vi } from 'vitest'
import { parse } from 'yaml'
import { mergeModelsBlock, writeModelConfig, type ConfigWriterDeps } from '../config-writer'

// index.ts pulls in electron-log/main transitively; stub it so buildConfigWriterDeps
// can be imported without an Electron runtime.
vi.mock('electron-log/main', () => ({ default: { info() {}, warn() {}, error() {} } }))

import { buildConfigWriterDeps } from '../index'

const cfg = { baseUrl: 'https://api.x.com/v1', apiKey: 'sk-abc', model: 'gpt-4o' }

describe('mergeModelsBlock', () => {
  it('writes models block on empty yaml', () => {
    const out = parse(mergeModelsBlock('', cfg))
    expect(out.models.default_model).toBe('gpt-4o')
    expect(out.models.providers).toEqual([
      { name: 'desktop', apiKey: 'sk-abc', apiBase: 'https://api.x.com/v1', models: ['gpt-4o'] }
    ])
  })

  it('preserves other top-level keys', () => {
    const existing = 'memory:\n  enabled: true\ngateway:\n  port: 0\n'
    const out = parse(mergeModelsBlock(existing, cfg))
    expect(out.memory).toEqual({ enabled: true })
    expect(out.gateway).toEqual({ port: 0 })
    expect(out.models.default_model).toBe('gpt-4o')
  })

  it('overwrites a pre-existing models block', () => {
    const existing = 'models:\n  default_model: old\n  providers:\n    - name: old\nfoo: bar\n'
    const out = parse(mergeModelsBlock(existing, cfg))
    expect(out.models.default_model).toBe('gpt-4o')
    expect(out.models.providers).toHaveLength(1)
    expect(out.models.providers[0].name).toBe('desktop')
    expect(out.foo).toBe('bar')
  })
})

describe('writeModelConfig', () => {
  function fakeDeps(initial: Record<string, string> = {}): {
    deps: ConfigWriterDeps; files: Record<string, string>; dirs: string[]
  } {
    const files: Record<string, string> = { ...initial }
    const dirs: string[] = []
    const deps: ConfigWriterDeps = {
      homeDir: '/home/u',
      readFile: (p) => { if (p in files) return files[p]; throw new Error('ENOENT') },
      writeFile: (p, data) => { files[p] = data },
      ensureDir: (p) => { dirs.push(p) }
    }
    return { deps, files, dirs }
  }

  it('writes merged yaml to configPath, treating missing file as empty', () => {
    const { deps, files } = fakeDeps()
    writeModelConfig(deps, { baseUrl: 'u', apiKey: 'k', model: 'm' })
    const written = files['/home/u/.echo-agent/echo-agent.yaml']
    expect(written).toBeTruthy()
    expect(parse(written).models.default_model).toBe('m')
  })

  it('ensures the config directory exists before writing', () => {
    const { deps, dirs } = fakeDeps()
    writeModelConfig(deps, { baseUrl: 'u', apiKey: 'k', model: 'm' })
    expect(dirs).toContain('/home/u/.echo-agent')
  })

  it('preserves existing config keys', () => {
    const { deps, files } = fakeDeps({
      '/home/u/.echo-agent/echo-agent.yaml': 'memory:\n  enabled: true\n'
    })
    writeModelConfig(deps, { baseUrl: 'u', apiKey: 'k', model: 'm' })
    const out = parse(files['/home/u/.echo-agent/echo-agent.yaml'])
    expect(out.memory).toEqual({ enabled: true })
    expect(out.models.default_model).toBe('m')
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
