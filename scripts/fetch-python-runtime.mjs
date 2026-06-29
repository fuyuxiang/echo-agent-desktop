// 构建前拉取内置 Python(python-build-standalone)到 resources/echo-runtime/python/<key>/。
// 不入库,随安装包分发,终端用户无需自带 Python。
// 用法: PYTHON_RUNTIME_BASE_URL=https://源地址 node scripts/fetch-python-runtime.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { pipeline } from 'node:stream/promises'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', 'resources', 'echo-runtime', 'python')

function platformKey(platform, arch) {
  if (platform === 'win32') return 'win-x64'
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
  throw new Error(`unsupported platform: ${platform}/${arch}`)
}

export function resolveTargets(platform, arch, baseUrl) {
  const key = platformKey(platform, arch)
  const ext = platform === 'win32' ? 'tar.gz' : 'tar.gz'
  return [{ key, url: `${baseUrl}/${key}.${ext}`, dest: path.join(ROOT, key) }]
}

async function download(url, dest) {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`下载失败 ${res.status}: ${url}`)
  const tmp = `${dest}.downloading`
  await pipeline(res.body, fs.createWriteStream(tmp))
  fs.renameSync(tmp, dest)
}

async function main() {
  const baseUrl = (process.env.PYTHON_RUNTIME_BASE_URL || '').replace(/\/+$/, '')
  if (!baseUrl) throw new Error('未提供 PYTHON_RUNTIME_BASE_URL')
  const targets = resolveTargets(process.platform, process.arch, baseUrl)
  for (const t of targets) {
    if (fs.existsSync(t.dest) && !process.argv.includes('--force')) {
      console.log(`[fetch-python] 已存在, 跳过: ${t.key}`)
      continue
    }
    fs.mkdirSync(ROOT, { recursive: true })
    const archive = path.join(ROOT, `${t.key}.tar.gz`)
    console.log(`[fetch-python] 下载 ${t.key} <- ${t.url}`)
    await download(t.url, archive)
    // 解压(用系统 tar,跨平台可用)
    const { execFileSync } = await import('node:child_process')
    fs.mkdirSync(t.dest, { recursive: true })
    execFileSync('tar', ['-xzf', archive, '-C', t.dest, '--strip-components=1'])
    fs.rmSync(archive, { force: true })
    console.log(`[fetch-python] 完成 ${t.key} -> ${t.dest}`)
  }
}

// 仅作为脚本直接运行时执行 main(被测试 import 时不执行)
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`[fetch-python] 错误: ${e.message}`); process.exit(1) })
}
