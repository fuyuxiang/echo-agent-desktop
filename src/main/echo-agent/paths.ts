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
// echo-agent-org 插件的私有数据区。凭证与离线缓存刻意放在配置文件之外:
// mergeManagedConfig 会整段改写它托管的键,token 落在那里会被覆盖掉;
// 且凭证需要 0600 权限,YAML 配置给不了。
export function orgPluginDir(homeDir: string): string {
  return join(echoHome(homeDir), 'plugins', 'org')
}
// 企业身份的唯一可信来源(JWT)。插件按 mtime 变化重载,故 desktop 重登后无需重启 agent。
export function orgCredentialsPath(homeDir: string): string {
  return join(orgPluginDir(homeDir), 'credentials.json')
}
// L2/L3 热文档离线缓存。desktop 经 /api/v1/sync 写入,插件只读。
export function orgCachePath(homeDir: string): string {
  return join(orgPluginDir(homeDir), 'cache.db')
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
