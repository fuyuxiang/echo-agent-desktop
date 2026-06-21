/**
 * 占位图标生成脚本(node scripts/generate-placeholder-icons.mjs)
 *
 * 生成:
 * - resources/icon.png         512x512 应用图标(品牌色圆角方块,正式图标到位后替换)
 * - resources/trayTemplate.png 16x16  托盘图标(黑色实心圆,mac Template 规范)
 *
 * 纯 Node 实现 PNG 编码(zlib),无第三方依赖
 */
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const resourcesDir = path.join(root, 'resources')

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

/** 将 RGBA 像素函数渲染为 PNG Buffer */
function makePng(size, pixelAt) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1)
    raw[rowStart] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelAt(x, y)
      const i = rowStart + 1 + x * 4
      raw[i] = r
      raw[i + 1] = g
      raw[i + 2] = b
      raw[i + 3] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---------- 绘制 ----------
/** 应用图标: 品牌色圆角方块 + 白色圆点 */
function appIconPixel(size) {
  const radius = size * 0.22
  const cx = size / 2
  const cy = size / 2
  const dotR = size * 0.18
  return (x, y) => {
    // 圆角矩形判定
    const pad = size * 0.04
    const minXY = pad + radius
    const maxXY = size - pad - radius
    const px = Math.min(Math.max(x, minXY), maxXY)
    const py = Math.min(Math.max(y, minXY), maxXY)
    const inRect =
      x >= pad &&
      x < size - pad &&
      y >= pad &&
      y < size - pad &&
      (x - px) ** 2 + (y - py) ** 2 <= radius ** 2
    if (!inRect) return [0, 0, 0, 0]
    // 白色圆点(代表 Echo 的回声点)
    if ((x - cx) ** 2 + (y - cy) ** 2 <= dotR ** 2) return [255, 255, 255, 255]
    return [79, 107, 254, 255] // --color-primary #4f6bfe
  }
}

/** 托盘图标: 黑色实心圆环(mac Template 图规范: 纯黑 + alpha) */
function trayIconPixel(size) {
  const c = size / 2
  const outer = size * 0.42
  const inner = size * 0.2
  return (x, y) => {
    const d2 = (x - c + 0.5) ** 2 + (y - c + 0.5) ** 2
    if (d2 <= outer ** 2 && d2 >= inner ** 2) return [0, 0, 0, 255]
    return [0, 0, 0, 0]
  }
}

fs.mkdirSync(resourcesDir, { recursive: true })
fs.writeFileSync(path.join(resourcesDir, 'icon.png'), makePng(512, appIconPixel(512)))
fs.writeFileSync(path.join(resourcesDir, 'trayTemplate.png'), makePng(32, trayIconPixel(32)))
console.log('占位图标已生成: resources/icon.png, resources/trayTemplate.png')
