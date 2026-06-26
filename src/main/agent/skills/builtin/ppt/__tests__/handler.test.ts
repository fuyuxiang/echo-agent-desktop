import { describe, it, expect, afterEach, vi } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))

import { generatePptTool, renderPptx, type PptOutline } from '../handler'

const outDir = path.join(os.tmpdir(), 'EchoAgent-PPT')
afterEach(() => {
  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true })
})

const ctx = { chatId: 'c1', workspace: '', signal: new AbortController().signal, onProgress: () => {} }

const sample: PptOutline = {
  title: '季度汇报',
  subtitle: '2026 Q2',
  theme: { primaryColor: '1F4E79' },
  slides: [
    { layout: 'title', title: '季度汇报', subtitle: '2026 Q2' },
    { layout: 'content', title: '核心指标', bullets: ['月活 100 万', '收入 +25%'] },
    { layout: 'two-column', title: '对比', left: ['旧方案'], right: ['新方案'] },
    { layout: 'table', title: '数据', headers: ['指标', '值'], rows: [['用户', '100K']] }
  ]
}

describe('renderPptx', () => {
  it('渲染 4 页生成 .pptx 文件', async () => {
    const out = path.join(os.tmpdir(), 'test-deck.pptx')
    const count = await renderPptx(sample, out)
    expect(count).toBe(4)
    expect(fs.existsSync(out)).toBe(true)
    expect(fs.statSync(out).size).toBeGreaterThan(0)
    fs.rmSync(out, { force: true })
  })
})

describe('generate_ppt 工具', () => {
  it('合法 outline 生成文件并返回路径', async () => {
    const r = await generatePptTool.execute({ outline: sample }, ctx)
    expect(r.ok).toBe(true)
    const parsed = JSON.parse(r.content) as { path: string; slideCount: number }
    expect(parsed.slideCount).toBe(4)
    expect(fs.existsSync(parsed.path)).toBe(true)
  })

  it('缺 title/slides 返回错误不抛', async () => {
    const r = await generatePptTool.execute({ outline: { slides: [] } }, ctx)
    expect(r.ok).toBe(false)
    expect(r.content).toContain('outline')
  })

  it('outline 非对象返回错误', async () => {
    const r = await generatePptTool.execute({}, ctx)
    expect(r.ok).toBe(false)
  })
})
