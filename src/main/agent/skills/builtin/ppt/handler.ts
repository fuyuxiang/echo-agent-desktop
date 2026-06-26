// src/main/agent/skills/builtin/ppt/handler.ts
import path from 'path'
import fs from 'fs'
import { app } from 'electron'
import PptxGenJS from 'pptxgenjs'
import type { Tool, ToolContext, ToolResult } from '../../../tools/base'

export interface PptTheme {
  primaryColor?: string // 十六进制不带 #
  fontFace?: string
}
export type PptSlide =
  | { layout: 'title'; title: string; subtitle?: string }
  | { layout: 'content'; title: string; bullets: string[]; notes?: string }
  | { layout: 'two-column'; title: string; left: string[]; right: string[] }
  | { layout: 'table'; title: string; headers: string[]; rows: string[][] }
export interface PptOutline {
  title: string
  subtitle?: string
  theme?: PptTheme
  slides: PptSlide[]
}

const DEFAULT_FONT = '微软雅黑'
const DEFAULT_COLOR = '1F4E79'

/** 把 outline 渲染成 .pptx 写到 outPath,返回页数。 */
export async function renderPptx(outline: PptOutline, outPath: string): Promise<number> {
  const pptx = new PptxGenJS()
  const color = outline.theme?.primaryColor ?? DEFAULT_COLOR
  const font = outline.theme?.fontFace ?? DEFAULT_FONT
  for (const s of outline.slides) {
    const slide = pptx.addSlide()
    if (s.layout === 'title') {
      slide.addText(s.title, { x: 0.5, y: 2, w: 9, h: 1.2, fontSize: 36, bold: true, color, fontFace: font })
      if (s.subtitle) slide.addText(s.subtitle, { x: 0.5, y: 3.2, w: 9, h: 0.8, fontSize: 20, color: '666666', fontFace: font })
    } else if (s.layout === 'content') {
      slide.addText(s.title, { x: 0.5, y: 0.4, w: 9, h: 0.8, fontSize: 28, bold: true, color, fontFace: font })
      slide.addText(s.bullets.map((b) => ({ text: b, options: { bullet: true } })), { x: 0.7, y: 1.4, w: 8.6, h: 4.5, fontSize: 18, fontFace: font })
      if (s.notes) slide.addNotes(s.notes)
    } else if (s.layout === 'two-column') {
      slide.addText(s.title, { x: 0.5, y: 0.4, w: 9, h: 0.8, fontSize: 28, bold: true, color, fontFace: font })
      slide.addText(s.left.map((b) => ({ text: b, options: { bullet: true } })), { x: 0.5, y: 1.4, w: 4.2, h: 4.5, fontSize: 16, fontFace: font })
      slide.addText(s.right.map((b) => ({ text: b, options: { bullet: true } })), { x: 5.0, y: 1.4, w: 4.2, h: 4.5, fontSize: 16, fontFace: font })
    } else {
      slide.addText(s.title, { x: 0.5, y: 0.4, w: 9, h: 0.8, fontSize: 28, bold: true, color, fontFace: font })
      const rows = [s.headers, ...s.rows].map((r) => r.map((c) => ({ text: c })))
      slide.addTable(rows, { x: 0.5, y: 1.4, w: 9, fontSize: 14, fontFace: font, border: { type: 'solid', color: 'CCCCCC', pt: 1 } })
    }
  }
  await pptx.writeFile({ fileName: outPath })
  return outline.slides.length
}

function isValidOutline(o: unknown): o is PptOutline {
  if (!o || typeof o !== 'object') return false
  const x = o as Partial<PptOutline>
  return typeof x.title === 'string' && x.title.trim() !== '' && Array.isArray(x.slides) && x.slides.length > 0
}

function sanitize(name: string): string {
  return name.replace(/[^\p{L}\p{N}\-_]+/gu, '_').slice(0, 40) || 'ppt'
}

export const generatePptTool: Tool = {
  name: 'generate_ppt',
  description: '将结构化大纲渲染为 PowerPoint (.pptx) 文件,返回文件绝对路径。',
  parameters: {
    type: 'object',
    properties: {
      outline: {
        type: 'object',
        description: 'PPT 结构化大纲: { title, subtitle?, theme?:{primaryColor?,fontFace?}, slides:[...] }',
        properties: {
          title: { type: 'string' },
          subtitle: { type: 'string' },
          theme: { type: 'object' },
          slides: { type: 'array' }
        },
        required: ['title', 'slides']
      }
    },
    required: ['outline']
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const outline = args.outline
    if (!isValidOutline(outline)) {
      return { ok: false, content: '非法 outline: 需含非空 title 与至少一页 slides' }
    }
    try {
      const dir = path.join(app.getPath('downloads'), 'EchoAgent-PPT')
      fs.mkdirSync(dir, { recursive: true })
      const outPath = path.join(dir, `${sanitize(outline.title)}-${Date.now()}.pptx`)
      const slideCount = await renderPptx(outline, outPath)
      return { ok: true, content: JSON.stringify({ path: outPath, slideCount }) }
    } catch (e) {
      return { ok: false, content: `PPT 生成失败: ${(e as Error).message}` }
    }
  }
}
