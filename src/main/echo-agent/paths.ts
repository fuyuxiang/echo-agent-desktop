import { join } from 'node:path'

export function echoHome(homeDir: string): string {
  return join(homeDir, '.echo-agent')
}
export function venvDir(homeDir: string): string {
  return join(echoHome(homeDir), 'runtime')
}
export function configPath(homeDir: string): string {
  return join(echoHome(homeDir), 'echo-agent.yaml')
}
export function venvPython(homeDir: string, platform: NodeJS.Platform): string {
  const base = venvDir(homeDir)
  return platform === 'win32' ? join(base, 'Scripts', 'python.exe') : join(base, 'bin', 'python')
}
export function bundledPythonKey(platform: NodeJS.Platform, arch: string): string {
  if (platform === 'win32') return 'win-x64'
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
  throw new Error(`unsupported platform: ${platform}`)
}
export function bundledPythonPath(resourcesPath: string, platform: NodeJS.Platform, arch: string): string {
  const key = bundledPythonKey(platform, arch)
  const dir = join(resourcesPath, 'echo-runtime', 'python', key)
  return platform === 'win32' ? join(dir, 'python.exe') : join(dir, 'bin', 'python3')
}
