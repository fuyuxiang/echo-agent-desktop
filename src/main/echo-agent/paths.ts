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
// 随安装包分发的 Python 运行时压缩包(python-build-standalone install_only,顶层 python/)。
// 打包形态:resources/python-standalone-<key>.tar.gz,运行期首启解压到用户数据区。
export function bundledPythonArchive(resourcesPath: string, platform: NodeJS.Platform, arch: string): string {
  const key = bundledPythonKey(platform, arch)
  return join(resourcesPath, `python-standalone-${key}.tar.gz`)
}
// 解压目标目录:~/.echo-agent/python(用户数据区,可写;打包资源区只读不能就地解压/建 venv)。
export function extractedPythonDir(homeDir: string): string {
  return join(echoHome(homeDir), 'python')
}
// 解压后的 Python 解释器(用于建 venv)。tar 顶层 python/ 经 --strip-components=1 落到上述目录,
// 故解释器位于 <dir>/bin/python3(posix)或 <dir>/python.exe(win)。
export function extractedPython(homeDir: string, platform: NodeJS.Platform): string {
  const dir = extractedPythonDir(homeDir)
  return platform === 'win32' ? join(dir, 'python.exe') : join(dir, 'bin', 'python3')
}
