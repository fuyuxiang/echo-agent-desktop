import { describe, it, expect } from 'vitest'
import { echoHome, venvDir, configPath, venvPython, bundledPythonKey, bundledPythonPath } from '../paths'

describe('echo-agent paths', () => {
  it('echoHome/venvDir/configPath join under home', () => {
    expect(echoHome('/Users/x')).toBe('/Users/x/.echo-agent')
    expect(venvDir('/Users/x')).toBe('/Users/x/.echo-agent/runtime')
    expect(configPath('/Users/x')).toBe('/Users/x/.echo-agent/echo-agent.yaml')
  })
  it('venvPython differs by platform', () => {
    expect(venvPython('/h', 'win32')).toBe('/h/.echo-agent/runtime/Scripts/python.exe')
    expect(venvPython('/h', 'darwin')).toBe('/h/.echo-agent/runtime/bin/python')
  })
  it('bundledPythonKey maps platform+arch', () => {
    expect(bundledPythonKey('win32', 'x64')).toBe('win-x64')
    expect(bundledPythonKey('darwin', 'x64')).toBe('mac-x64')
    expect(bundledPythonKey('darwin', 'arm64')).toBe('mac-arm64')
  })
  it('bundledPythonPath uses key and platform binary', () => {
    expect(bundledPythonPath('/res', 'darwin', 'arm64'))
      .toBe('/res/echo-runtime/python/mac-arm64/bin/python3')
    expect(bundledPythonPath('/res', 'win32', 'x64'))
      .toBe('/res/echo-runtime/python/win-x64/python.exe')
  })
})
