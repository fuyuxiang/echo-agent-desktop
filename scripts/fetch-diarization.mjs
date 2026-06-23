// 下载离线说话人分离(diarization)模型到 resources/models/diarization/,
// 随安装包一起分发。终端用户无需联网下载模型。
//
// 模型不入库(约 44MB),由本脚本在构建前从公司内网源拉取。
//
// 用法:
//   DIARIZATION_MODEL_BASE_URL=http://内网地址 node scripts/fetch-diarization.mjs
//   node scripts/fetch-diarization.mjs --base-url http://内网地址
//   node scripts/fetch-diarization.mjs --force        # 已存在也重新下载
//
// 基地址下应能按 <base>/diarization/<文件名> 直接取到下列 2 个文件。
//
// 产物 (路径与 src/main/meeting/diarization.ts 约定一致):
//   resources/models/diarization/
//     ├── segmentation.onnx
//     └── embedding.onnx

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MODEL_DIR = path.join(__dirname, '..', 'resources', 'models', 'diarization')

// 默认从公司内网源拉取; 可用环境变量 DIARIZATION_MODEL_BASE_URL 或 --base-url 覆盖
const DEFAULT_BASE_URL = 'http://123.56.188.16'

// 文件名 -> 预期最小字节数(用于校验下载是否完整,避免半截文件)
const FILES = {
  'segmentation.onnx': 4_000_000,
  'embedding.onnx': 30_000_000
}

function parseArgs() {
  const argv = process.argv.slice(2)
  const force = argv.includes('--force')
  const urlIdx = argv.indexOf('--base-url')
  const baseUrl =
    (urlIdx >= 0 ? argv[urlIdx + 1] : process.env.DIARIZATION_MODEL_BASE_URL) || DEFAULT_BASE_URL
  return { force, baseUrl: baseUrl.replace(/\/+$/, '') }
}

async function download(url, dest) {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`下载失败 ${res.status}: ${url}`)
  const tmp = `${dest}.downloading`
  await pipeline(res.body, fs.createWriteStream(tmp))
  fs.renameSync(tmp, dest)
}

async function main() {
  const { force, baseUrl } = parseArgs()
  if (!baseUrl) {
    throw new Error(
      '未提供模型下载地址。请设置环境变量 DIARIZATION_MODEL_BASE_URL 或传 --base-url <公司内网地址>'
    )
  }

  fs.mkdirSync(MODEL_DIR, { recursive: true })

  for (const [name, minSize] of Object.entries(FILES)) {
    const dest = path.join(MODEL_DIR, name)
    if (!force && fs.existsSync(dest) && fs.statSync(dest).size >= minSize) {
      console.log(`[fetch-diarization] 已存在, 跳过: ${name}`)
      continue
    }

    const url = `${baseUrl}/diarization/${name}`
    console.log(`[fetch-diarization] 下载 ${name} <- ${url}`)
    await download(url, dest)

    const size = fs.statSync(dest).size
    if (size < minSize) {
      fs.rmSync(dest, { force: true })
      throw new Error(
        `${name} 下载不完整 (${size} 字节, 预期 ≥ ${minSize})。请检查内网地址与文件。`
      )
    }
    console.log(`[fetch-diarization] 完成 ${name} (${(size / 1024 / 1024).toFixed(1)} MB)`)
  }

  console.log(`[fetch-diarization] 全部就绪 -> resources/models/diarization`)
}

main().catch((e) => {
  console.error(`[fetch-diarization] 错误: ${e.message}`)
  process.exit(1)
})
