import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import {
  echoHome, venvDir, configPath, venvPython, bundledPythonKey,
  bundledPythonArchive, extractedPythonDir, extractedPython
} from '../paths'

describe('echo-agent paths', () => {
  it('echoHome/venvDir/configPath join under home', () => {
    expect(echoHome('/Users/x')).toBe(join('/Users/x', '.echo-agent'))
    expect(venvDir('/Users/x')).toBe(join('/Users/x', '.echo-agent', 'runtime'))
    expect(configPath('/Users/x')).toBe(join('/Users/x', '.echo-agent', 'echo-agent.yaml'))
  })
  it('venvPython differs by platform', () => {
    expect(venvPython('/h', 'win32')).toBe(join('/h', '.echo-agent', 'runtime', 'Scripts', 'python.exe'))
    expect(venvPython('/h', 'darwin')).toBe(join('/h', '.echo-agent', 'runtime', 'bin', 'python'))
  })
  it('bundledPythonKey maps platform+arch', () => {
    expect(bundledPythonKey('win32', 'x64')).toBe('win-x64')
    expect(bundledPythonKey('darwin', 'x64')).toBe('mac-x64')
    expect(bundledPythonKey('darwin', 'arm64')).toBe('mac-arm64')
  })
  it('bundledPythonArchive points at per-key tar.gz in resources', () => {
    expect(bundledPythonArchive('/res', 'darwin', 'arm64'))
      .toBe(join('/res', 'python-standalone-mac-arm64.tar.gz'))
    expect(bundledPythonArchive('/res', 'win32', 'x64'))
      .toBe(join('/res', 'python-standalone-win-x64.tar.gz'))
  })
  it('extractedPythonDir/extractedPython resolve under user home', () => {
    expect(extractedPythonDir('/h')).toBe(join('/h', '.echo-agent', 'python'))
    expect(extractedPython('/h', 'darwin')).toBe(join('/h', '.echo-agent', 'python', 'bin', 'python3'))
    expect(extractedPython('/h', 'win32')).toBe(join('/h', '.echo-agent', 'python', 'python.exe'))
  })
})
