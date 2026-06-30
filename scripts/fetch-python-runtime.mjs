// 构建前拉取内置 Python(python-build-standalone)到 resources/python-standalone-<key>.tar.gz。
// 不入库,随安装包分发(per-arch),运行期首启解压到用户数据区,终端用户无需自带 Python。
//
// 默认直连 GitHub astral-sh/python-build-standalone 最新 release(install_only 包)。
// 内网/受限环境可设 PYTHON_RUNTIME_BASE_URL,改从 <base>/<key>.tar.gz 直接拉(免查 GitHub API)。
//
// 用法:
//   node scripts/fetch-python-runtime.mjs            # 当前平台全部 arch
//   node scripts/fetch-python-runtime.mjs --force    # 已存在也重新下载
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { pipeline } from 'node:stream/promises'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RESOURCES_DIR = path.join(__dirname, '..', 'resources')
const PY_SERIES = '3.12'
const RELEASES_API = 'https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest'

// 平台 key -> python-build-standalone 的 triple
const TRIPLES = {
  'mac-arm64': 'aarch64-apple-darwin',
  'mac-x64': 'x86_64-apple-darwin',
  'win-x64': 'x86_64-pc-windows-msvc'
}

export function platformKey(platform, arch) {
  if (platform === 'win32') return 'win-x64'
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
  throw new Error(`unsupported platform: ${platform}/${arch}`)
}

function destForKey(key) {
  return path.join(RESOURCES_DIR, `python-standalone-${key}.tar.gz`)
}

// baseUrl 提供时(内网覆盖源):直接拼 <base>/<key>.tar.gz;否则 url 为 null,留待 GitHub release 解析。
function targetForKey(key, baseUrl) {
  return {
    key,
    triple: TRIPLES[key],
    url: baseUrl ? `${baseUrl}/${key}.tar.gz` : null,
    dest: destForKey(key)
  }
}

export function resolveTargets(platform, arch, baseUrl) {
  const key = platformKey(platform, arch)
  return [targetForKey(key, baseUrl)]
}

// 返回某平台需打包的全部 arch 目标:
// mac → arm64 + x64 两个(build:mac 同时出两份 dmg,任一 arch 的包都要含运行时);
// win → x64;linux 不支持。
export function resolveAllTargets(platform, baseUrl) {
  if (platform === 'darwin') {
    return ['mac-arm64', 'mac-x64'].map((k) => targetForKey(k, baseUrl))
  }
  if (platform === 'win32') {
    return [targetForKey('win-x64', baseUrl)]
  }
  throw new Error(`unsupported platform: ${platform}`)
}

// 在 GitHub release 资产里匹配某 triple 的 cpython install_only 包。
export function matchAsset(assets, triple) {
  const re = new RegExp(
    `^cpython-${PY_SERIES.replace('.', '\\.')}\\.\\d+\\+\\d+-${triple}-install_only\\.tar\\.gz$`
  )
  return assets.find((a) => re.test(a.name))
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
  const tmp = `${dest}.downloading`
  await pipeline(res.body, fs.createWriteStream(tmp))
  fs.renameSync(tmp, dest)
}

async function main() {
  const baseUrl = (process.env.PYTHON_RUNTIME_BASE_URL || '').replace(/\/+$/, '')
  const targets = resolveAllTargets(process.platform, baseUrl || null)
  fs.mkdirSync(RESOURCES_DIR, { recursive: true })

  // 无覆盖源时:查一次 GitHub latest release,后续按 triple 匹配资产 URL。
  let release = null
  const needRelease = targets.some((t) => !t.url)
  if (needRelease) {
    console.log('[fetch-python] 查询最新 release...')
    release = await fetchJson(RELEASES_API)
    console.log(`[fetch-python] tag=${release.tag_name}`)
  }

  for (const t of targets) {
    if (fs.existsSync(t.dest) && !process.argv.includes('--force')) {
      console.log(`[fetch-python] 已存在, 跳过: ${t.key}`)
      continue
    }
    let url = t.url
    if (!url) {
      const asset = matchAsset(release.assets, t.triple)
      if (!asset) throw new Error(`未找到匹配资源: ${t.key} (${t.triple})`)
      url = asset.browser_download_url
    }
    console.log(`[fetch-python] 下载 ${t.key} <- ${url}`)
    await download(url, t.dest)
    const mb = (fs.statSync(t.dest).size / 1024 / 1024).toFixed(1)
    console.log(`[fetch-python] 完成 ${t.key} -> ${t.dest} (${mb} MB)`)
  }
}

// 仅作为脚本直接运行时执行 main(被测试 import 时不执行)
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`[fetch-python] 错误: ${e.message}`); process.exit(1) })
}
