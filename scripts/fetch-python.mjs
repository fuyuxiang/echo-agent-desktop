// 下载独立 Python 运行时 (python-build-standalone) 到 resources/,
// 随安装包一起分发。终端用户机器无需预装 Python。
//
// 用法:
//   node scripts/fetch-python.mjs              # 当前平台 + 架构
//   node scripts/fetch-python.mjs --all-mac    # mac arm64 + x64
//   node scripts/fetch-python.mjs --platform win --arch x64
//
// 产物 (名称与 src/main/agent-process 约定一致):
//   resources/python-standalone-mac.tar.gz     (macOS, 按 --arch 选择)
//   resources/python-standalone-win.tar.gz     (Windows x64)

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RESOURCES_DIR = path.join(__dirname, '..', 'resources')
const PY_SERIES = '3.12'
const RELEASES_API =
  'https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest'

// 平台-架构 -> { triple, outName }
const TARGETS = {
  'mac-arm64': { triple: 'aarch64-apple-darwin', out: 'python-standalone-mac-arm64.tar.gz' },
  'mac-x64': { triple: 'x86_64-apple-darwin', out: 'python-standalone-mac-x64.tar.gz' },
  'win-x64': { triple: 'x86_64-pc-windows-msvc', out: 'python-standalone-win-x64.tar.gz' }
}

function parseArgs() {
  const argv = process.argv.slice(2)
  if (argv.includes('--all-mac')) return ['mac-arm64', 'mac-x64']

  const platIdx = argv.indexOf('--platform')
  const archIdx = argv.indexOf('--arch')
  let platform = platIdx >= 0 ? argv[platIdx + 1] : process.platform === 'win32' ? 'win' : 'mac'
  let arch = archIdx >= 0 ? argv[archIdx + 1] : process.arch === 'arm64' ? 'arm64' : 'x64'
  if (platform === 'darwin') platform = 'mac'
  if (platform === 'win32') platform = 'win'
  if (platform === 'win') arch = 'x64' // build-standalone 仅提供 win x64
  return [`${platform}-${arch}`]
}

async function fetchJson(url) {
  const headers = { 'User-Agent': 'echo-agent-desktop-fetch-python' }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`)
  return res.json()
}

async function download(url, dest) {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`下载失败 ${res.status}: ${url}`)
  await pipeline(res.body, fs.createWriteStream(dest))
}

async function main() {
  const keys = parseArgs()
  fs.mkdirSync(RESOURCES_DIR, { recursive: true })

  console.log(`[fetch-python] 查询最新 release...`)
  const release = await fetchJson(RELEASES_API)
  console.log(`[fetch-python] tag=${release.tag_name}`)

  for (const key of keys) {
    const target = TARGETS[key]
    if (!target) throw new Error(`未知目标: ${key} (支持: ${Object.keys(TARGETS).join(', ')})`)

    const re = new RegExp(`^cpython-${PY_SERIES.replace('.', '\\.')}\\.\\d+\\+\\d+-${target.triple}-install_only\\.tar\\.gz$`)
    const asset = release.assets.find((a) => re.test(a.name))
    if (!asset) throw new Error(`未找到匹配资源: ${key} (${target.triple})`)

    const dest = path.join(RESOURCES_DIR, target.out)
    console.log(`[fetch-python] ${key}: ${asset.name} -> resources/${target.out}`)
    await download(asset.browser_download_url, dest)
    const mb = (fs.statSync(dest).size / 1024 / 1024).toFixed(1)
    console.log(`[fetch-python] 完成 (${mb} MB)`)
  }
}

main().catch((e) => {
  console.error(`[fetch-python] 错误: ${e.message}`)
  process.exit(1)
})
