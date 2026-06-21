// 下载本地语音识别(sherpa-onnx)模型到 resources/models/asr/,
// 随安装包一起分发。终端用户无需联网下载模型,客户端打开即可用。
//
// 模型不入库(约 189MB),由本脚本在构建前从公司内网源拉取。
//
// 用法:
//   ASR_MODEL_BASE_URL=https://内网地址/asr node scripts/fetch-asr.mjs
//   node scripts/fetch-asr.mjs --base-url https://内网地址/asr
//   node scripts/fetch-asr.mjs --force        # 已存在也重新下载
//
// 基地址下应能按 <base>/<文件名> 直接取到下列 4 个文件。
//
// 产物 (路径与 src/main/asr/index.ts 约定一致):
//   resources/models/asr/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/
//     ├── encoder-epoch-99-avg-1.int8.onnx
//     ├── decoder-epoch-99-avg-1.int8.onnx
//     ├── joiner-epoch-99-avg-1.int8.onnx
//     └── tokens.txt

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MODEL_PREFIX = 'sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20'
const MODEL_DIR = path.join(__dirname, '..', 'resources', 'models', 'asr', MODEL_PREFIX)

// 文件名 -> 预期最小字节数(用于校验下载是否完整,避免半截文件)
const FILES = {
  'encoder-epoch-99-avg-1.int8.onnx': 150_000_000,
  'decoder-epoch-99-avg-1.int8.onnx': 10_000_000,
  'joiner-epoch-99-avg-1.int8.onnx': 2_000_000,
  'tokens.txt': 10_000
}

function parseArgs() {
  const argv = process.argv.slice(2)
  const force = argv.includes('--force')
  const urlIdx = argv.indexOf('--base-url')
  const baseUrl = (urlIdx >= 0 ? argv[urlIdx + 1] : process.env.ASR_MODEL_BASE_URL) || ''
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
      '未提供模型下载地址。请设置环境变量 ASR_MODEL_BASE_URL 或传 --base-url <公司内网地址>'
    )
  }

  fs.mkdirSync(MODEL_DIR, { recursive: true })

  for (const [name, minSize] of Object.entries(FILES)) {
    const dest = path.join(MODEL_DIR, name)
    if (!force && fs.existsSync(dest) && fs.statSync(dest).size >= minSize) {
      console.log(`[fetch-asr] 已存在, 跳过: ${name}`)
      continue
    }

    const url = `${baseUrl}/${name}`
    console.log(`[fetch-asr] 下载 ${name} <- ${url}`)
    await download(url, dest)

    const size = fs.statSync(dest).size
    if (size < minSize) {
      fs.rmSync(dest, { force: true })
      throw new Error(
        `${name} 下载不完整 (${size} 字节, 预期 ≥ ${minSize})。请检查内网地址与文件。`
      )
    }
    console.log(`[fetch-asr] 完成 ${name} (${(size / 1024 / 1024).toFixed(1)} MB)`)
  }

  console.log(`[fetch-asr] 全部就绪 -> resources/models/asr/${MODEL_PREFIX}`)
}

main().catch((e) => {
  console.error(`[fetch-asr] 错误: ${e.message}`)
  process.exit(1)
})
